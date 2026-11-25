"""Normalize raw FIRMS CSVs (archive + API) into one tidy Parquet table per region.

Output: cache/<Region>.parquet with columns
    lat, lon, date, time, platform (T=Terra, A=Aqua, N=S-NPP, J1=NOAA-20), family (MODIS/VIIRS),
    conf (str, raw), conf_ok (bool), frp, bright, dn (D/N), type (int, -1 = unknown),
    src (SP / NRT)

Rules
* Archive CSVs (yearly country files) are Standard Processing (science quality).
* API CSVs cover the current year; SP is preferred, NRT is used only after the
  last SP date. API points come from a bounding box and are clipped to the
  Natural Earth country polygon.
* NRT records have no ``type`` field. We transfer it from the SP record: any
  ~1 km cell that was ever flagged as volcano (1) or static land source (2) in SP
  is flagged the same way in NRT, so gas flares / industry stay excluded.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import polars as pl
import shapely
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent
RAW, CACHE, REF = ROOT / "raw", ROOT / "cache", ROOT / "ref"

PLATFORM = {"Terra": "T", "Aqua": "A", "N": "N", "Suomi NPP": "N", "1": "J1", "N20": "J1", "NOAA-20": "J1",
            "2": "J2", "N21": "J2", "NOAA-21": "J2"}


def read_csv(path: Path, src: str) -> pl.DataFrame | None:
    if path.stat().st_size < 200:
        return None
    df = pl.read_csv(path, infer_schema_length=0)  # all strings, cast explicitly
    if df.height == 0 or "latitude" not in df.columns:
        return None
    viirs = "bright_ti4" in df.columns
    out = df.select(
        pl.col("latitude").cast(pl.Float64).alias("lat"),
        pl.col("longitude").cast(pl.Float64).alias("lon"),
        pl.col("acq_date").str.to_date("%Y-%m-%d").alias("date"),
        pl.col("acq_time").cast(pl.Int16).alias("time"),
        pl.col("satellite").replace_strict(PLATFORM, default="?").alias("platform"),
        pl.lit("VIIRS" if viirs else "MODIS").alias("family"),
        pl.col("confidence").alias("conf"),
        pl.col("frp").cast(pl.Float32).alias("frp"),
        pl.col("bright_ti4" if viirs else "brightness").cast(pl.Float32).alias("bright"),
        pl.col("daynight").alias("dn"),
        (pl.col("type").cast(pl.Int8) if "type" in df.columns else pl.lit(-1, pl.Int8)).alias("type"),
        pl.lit(src).alias("src"),
    )
    return out


def country_polygon(name: str):
    gj = json.loads((REF / "ne_50m_admin_0_countries.geojson").read_text(encoding="utf-8"))
    for f in gj["features"]:
        p = f["properties"]
        if name in (p.get("ADMIN"), p.get("NAME"), p.get("NAME_LONG")):
            g = shape(f["geometry"])
            shapely.prepare(g)
            return g
    raise SystemExit(f"Country polygon not found: {name}")


def process_region(name: str) -> Path:
    base = RAW / name
    frames = []
    for sensor in ("modis", "viirs-snpp"):
        for f in sorted((base / sensor).glob("*.csv")):
            d = read_csv(f, "SP")
            if d is not None:
                frames.append(d)
    archive = pl.concat(frames) if frames else None
    archive_years = (set(archive.select("platform", pl.col("date").dt.year().alias("y")).unique().iter_rows())
                     if archive is not None else set())

    api = []
    for f in sorted((base / "api").glob("*/*.csv")):
        d = read_csv(f, "NRT" if "NRT" in f.parent.name else "SP")
        if d is not None:
            api.append(d)
    if api:
        a = pl.concat(api, how="vertical_relaxed")
        # API data only fills platform-years that are missing from the yearly archive
        keep = [(p, y) not in archive_years for p, y in zip(a["platform"].to_list(), a["date"].dt.year().to_list())]
        a = a.filter(pl.Series(keep))
        # prefer SP over NRT for the same family/day
        sp_days = a.filter(pl.col("src") == "SP").select("platform", "date").unique()
        a = pl.concat([
            a.filter(pl.col("src") == "SP"),
            a.filter(pl.col("src") == "NRT").join(sp_days, on=["platform", "date"], how="anti"),
        ])
        poly = country_polygon(name)
        inside = shapely.contains_xy(poly, a["lon"].to_numpy(), a["lat"].to_numpy())
        a = a.filter(pl.Series(inside))
        a = a.unique(subset=["lat", "lon", "date", "time", "platform"])  # 5-day windows may overlap
        frames = [archive, a] if archive is not None else [a]
        df = pl.concat(frames, how="vertical_relaxed")
    else:
        df = archive

    # confidence: MODIS 0-100 (>=30 = nominal/high), VIIRS l/n/h
    df = df.with_columns(
        pl.when(pl.col("family") == "MODIS")
        .then(pl.col("conf").cast(pl.Int32, strict=False).fill_null(0) >= 30)
        .otherwise(pl.col("conf").is_in(["n", "h", "nominal", "high"]))
        .alias("conf_ok")
    )

    # transfer static-source flags (type 1/2) to NRT records via ~1 km cells
    fine = (pl.col("lat") * 100).floor().cast(pl.Int32).alias("fi"), (pl.col("lon") * 100).floor().cast(pl.Int32).alias("fj")
    df = df.with_columns(*fine)
    static = df.filter(pl.col("type").is_in([1, 2])).group_by("fi", "fj").agg(pl.col("type").max().alias("stype"))
    df = (
        df.join(static, on=["fi", "fj"], how="left")
        .with_columns(
            pl.when(pl.col("type") == -1)
            .then(pl.col("stype").fill_null(0))
            .otherwise(pl.col("type"))
            .cast(pl.Int8)
            .alias("type")
        )
        .drop("stype")
        .sort("date", "time")
    )
    CACHE.mkdir(exist_ok=True)
    out = CACHE / f"{name}.parquet"
    df.write_parquet(out, compression="zstd")
    summ = df.group_by("platform", "src").agg(pl.len(), pl.col("date").min().alias("first"), pl.col("date").max().alias("last")).sort("platform", "src")
    print(f"{name}: {df.height:,} detections -> {out.name}\n{summ}")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("regions", nargs="*", default=["Philippines"])
    for r in ap.parse_args().regions:
        process_region(r)
