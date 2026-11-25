"""Export harmonized products to compact static files for the web app.

web/public/data/
  regions.json
  <id>/meta.json            calibration, validation, uncertainty, eras, file sizes
  <id>/cells.bin.gz         struct-of-arrays: id u32 | H f32 | ym u16 | T u16 | A u16 | N u16
  <id>/partial.bin.gz       same-days history for the latest month: id u32 | H f32 | year u16
  <id>/points/<fam>_<year>.bin.gz
                            raw detections: lat i32 | lon i32 (1e-5 deg) | frp f32 | bright f32 |
                            day u16 (since 2000-01-01) | time u16 | platform u8 | conf u8 |
                            dn u8 | type u8 | flags u8 (bit0 NRT, bit1 conf_ok)
"""
from __future__ import annotations

import gzip
import json
import shutil
from pathlib import Path

import numpy as np
import polars as pl

ROOT = Path(__file__).resolve().parent
CACHE, OUT = ROOT / "cache", ROOT / "out"
WEB = ROOT.parent / "web" / "public" / "data"
PLAT = {"T": 0, "A": 1, "N": 2, "J1": 3}
VCONF = {"l": 1, "n": 2, "h": 3, "low": 1, "nominal": 2, "high": 3}


def cell_id(ci: np.ndarray, cj: np.ndarray) -> np.ndarray:
    return ((ci + 900) * 3600 + (cj + 1800)).astype(np.uint32)


def write_gz(path: Path, arrays: list[np.ndarray]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = b"".join(np.ascontiguousarray(a).tobytes() for a in arrays)
    with gzip.open(path, "wb", compresslevel=9) as f:
        f.write(raw)
    return path.stat().st_size


def export(region: dict) -> dict:
    name, rid = region["name"], region["id"]
    rep = json.loads((OUT / name / "report.json").read_text())
    dest = WEB / rid
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    cells = pl.read_parquet(OUT / name / "cells.parquet").filter(pl.col("H") > 0).sort("ci", "cj", "ym")
    ci, cj = cells["ci"].to_numpy(), cells["cj"].to_numpy()
    ids = cell_id(ci, cj)
    order = np.lexsort((cells["ym"].to_numpy(), ids))
    clip16 = lambda s: np.clip(np.rint(s.to_numpy()[order]), 0, 65535).astype(np.uint16)
    size_cells = write_gz(dest / "cells.bin.gz", [
        ids[order], cells["H"].to_numpy()[order].astype(np.float32), cells["ym"].to_numpy()[order].astype(np.uint16),
        clip16(cells["T"]), clip16(cells["A"]), clip16(cells.select(pl.when(pl.col("N") > 0).then(pl.col("N")).otherwise(pl.col("J1"))).to_series()),
    ])

    part = pl.read_parquet(OUT / name / "partial.parquet").filter(pl.col("H") > 0)
    n_partial = part.height
    if n_partial:
        write_gz(dest / "partial.bin.gz", [
            cell_id(part["ci"].to_numpy(), part["cj"].to_numpy()), part["H"].to_numpy().astype(np.float32),
            part["year"].to_numpy().astype(np.uint16),
        ])

    # raw detections per family/year
    df = pl.read_parquet(CACHE / f"{name}.parquet").filter(pl.col("platform").is_in(list(PLAT)))
    df = df.with_columns(((pl.col("date") - pl.date(2000, 1, 1)).dt.total_days()).alias("day"),
                         pl.col("date").dt.year().alias("year"))
    points: dict[str, dict[str, int]] = {"MODIS": {}, "VIIRS": {}}
    size_pts = 0
    for (fam, year), g in df.group_by(["family", "year"], maintain_order=True):
        conf = (g["conf"].cast(pl.Int32, strict=False).fill_null(0).clip(0, 100).to_numpy() if fam == "MODIS"
                else g["conf"].replace_strict(VCONF, default=0, return_dtype=pl.UInt8).to_numpy())
        flags = (g["src"] == "NRT").cast(pl.UInt8).to_numpy() | (g["conf_ok"].cast(pl.UInt8).to_numpy() << 1)
        size_pts += write_gz(dest / "points" / f"{fam.lower()}_{year}.bin.gz", [
            np.rint(g["lat"].to_numpy() * 1e5).astype(np.int32), np.rint(g["lon"].to_numpy() * 1e5).astype(np.int32),
            g["frp"].fill_null(0).to_numpy().astype(np.float32), g["bright"].fill_null(0).to_numpy().astype(np.float32),
            g["day"].to_numpy().astype(np.uint16), g["time"].fill_null(0).to_numpy().astype(np.uint16),
            g["platform"].replace_strict(PLAT, return_dtype=pl.UInt8).to_numpy(), conf.astype(np.uint8),
            (g["dn"] == "N").cast(pl.UInt8).to_numpy(), g["type"].clip(0, 3).cast(pl.UInt8).to_numpy(), flags.astype(np.uint8),
        ])
        points[fam][str(year)] = g.height

    incomplete = [f["ym"] for f in rep["incomplete_months"]]
    meta = {
        "id": rid, "name": name, "label": region["label"], "bbox": region["bbox"],
        "last_date": rep["last_date"], "ym0": rep["eras"]["ym0"], "ym_last": rep["ym_last"],
        "partial_day": rep["partial_day"],
        "eras": {"aqua_start": rep["eras"]["aqua_start"], "viirs_start": rep["eras"]["viirs_start"]},
        "viirs_eq_factor": rep["viirs_eq_factor"],
        "unc": {"viirs": rep["uncertainty_bins_viirs"], "terra": rep["uncertainty_bins_terra"]},
        "incomplete": incomplete,
        "fallback": {str((int(k[:4]) - 2000) * 12 + int(k[5:]) - 1): v for k, v in rep.get("fallback_months", {}).items()},
        "n_records": int(len(ids)), "n_partial": int(n_partial),
        "points": points,
        "report": {k: rep[k] for k in ("n_detections", "n_detections_by_platform", "calibration_viirs_to_aqua",
                                       "calibration_terra_to_aqua", "raw_pixel_ratio_viirs_over_aqua",
                                       "afcd_ratio_viirs_over_aqua", "validation_viirs_loyo", "validation_terra_loyo",
                                       "drift_diagnostic", "incomplete_months", "fallback_months",
                                       "calibration_noaa20_to_snpp", "validation_noaa20_loyo", "outage_months",
                                       "calibration_months", "generated")},
        "sizes": {"cells_gz": size_cells, "points_gz": size_pts},
    }
    (dest / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    # region-level monthly series for the method page charts
    shutil.copy(OUT / name / "region_monthly.csv", dest / "region_monthly.csv")
    print(f"{rid}: {len(ids):,} cell-months ({size_cells/1e6:.2f} MB), points {size_pts/1e6:.1f} MB, partial {n_partial}")
    return {k: region[k] for k in ("id", "name", "label", "bbox")}


if __name__ == "__main__":
    regions = json.loads((ROOT / "regions.json").read_text())
    done = [export(r) for r in regions if (OUT / r["name"] / "report.json").exists()]
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "regions.json").write_text(json.dumps(done, indent=1))
