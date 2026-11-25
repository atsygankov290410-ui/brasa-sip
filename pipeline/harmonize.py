"""MODIS / VIIRS active-fire harmonization ("reference satellite" method).

Pipeline (see docs/METHODOLOGY.md for the full description and references):

1. Filter      type == 0 (vegetation fire), MODIS confidence >= 30, VIIRS n/h.
2. Dedup       Each detection is snapped to a ~1 km (0.01 deg) cell; one record per
               (cell, day, day/night, platform) -> "active-fire cell-day" (AFCD).
               This removes the 375 m-vs-1 km pixel multiplicity, bow-tie duplicates
               and repeated looks from overlapping orbits.
3. Calibrate   Reference = Aqua MODIS (13:30 overpass, same as S-NPP VIIRS; used by
               INPE as the "satelite de referencia"). Ratios Aqua/VIIRS are fitted on
               the stable overlap 2012-02..2021-06 (before Aqua orbit drift):
                 r[dn]           regional ratio
                 r[dn, moy]      seasonal ratio shrunk to r[dn] with a0 pseudo-counts
                 theta[k, dn]    empirical-Bayes multiplier per 0.5 deg cell (Marshall 1991)
               Terra -> Aqua is fitted the same way on 2003-2019 (before Terra drift).
4. Assemble    H = Terra->Aqua (2000-11..2002-06) | Aqua observed (2002-07..2021-06)
               | VIIRS->Aqua (2021-07..present). Units: Aqua-MODIS-equivalent hotspots.
5. Validate    Leave-one-year-out CV over the overlap, compared with naive baselines.
6. Uncertainty Empirical 90 % prediction intervals from LOYO residuals by count size.

Usage: python harmonize.py [Region ...]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import polars as pl

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT / "out"

GRID = 0.1           # analysis grid (deg)
CAL = 0.5            # calibration cell for EB multipliers (deg)
FINE = 0.01          # dedup cell (~1 km)
CAL_K = round(CAL / GRID)  # analysis cells per calibration cell side (integer maths avoids float edge cases)
A0 = 50.0            # seasonal shrinkage pseudo-count
MIN_NIGHT = 100      # min Aqua night AFCD in the window to fit night separately

YM0 = 10             # 2000-11 as month index ((y-2000)*12 + m-1)
AQUA_START = (2002 - 2000) * 12 + 6      # 2002-07
VIIRS_CAL = ((2012 - 2000) * 12 + 1, (2021 - 2000) * 12 + 5)   # 2012-02..2021-06
TERRA_CAL = ((2003 - 2000) * 12 + 0, (2019 - 2000) * 12 + 11)  # 2003-01..2019-12
VIIRS_ERA = (2021 - 2000) * 12 + 6       # 2021-07: harmonized values come from VIIRS
J1_CAL_START = (2024 - 2000) * 12 + 0    # NOAA-20 -> S-NPP overlap used for the nested ratio


def ym_to_str(i: int) -> str:
    return f"{2000 + i // 12}-{i % 12 + 1:02d}"


# ----------------------------------------------------------------------------- 1-2
def afcd(df: pl.DataFrame) -> pl.DataFrame:
    """Filtered, deduplicated active-fire cell-days aggregated to GRID x month."""
    d = df.filter((pl.col("type") == 0) & pl.col("conf_ok") & pl.col("platform").is_in(["T", "A", "N", "J1"]))
    d = d.with_columns(
        (pl.col("lat") / FINE).floor().cast(pl.Int32).alias("fi"),
        (pl.col("lon") / FINE).floor().cast(pl.Int32).alias("fj"),
    ).unique(subset=["fi", "fj", "date", "dn", "platform"])
    return (
        d.with_columns(
            (pl.col("lat") / GRID).floor().cast(pl.Int32).alias("ci"),
            (pl.col("lon") / GRID).floor().cast(pl.Int32).alias("cj"),
            ((pl.col("date").dt.year() - 2000) * 12 + pl.col("date").dt.month() - 1).cast(pl.Int32).alias("ym"),
        )
        .group_by("ci", "cj", "ym", "dn", "platform")
        .agg(pl.len().cast(pl.Float64).alias("n"))
    )


def raw_pixels(df: pl.DataFrame) -> pl.DataFrame:
    """Non-deduplicated pixel counts (same filters) — used for the naive baseline."""
    d = df.filter((pl.col("type") == 0) & pl.col("conf_ok") & pl.col("platform").is_in(["T", "A", "N", "J1"]))
    return (
        d.with_columns(
            (pl.col("lat") / GRID).floor().cast(pl.Int32).alias("ci"),
            (pl.col("lon") / GRID).floor().cast(pl.Int32).alias("cj"),
            ((pl.col("date").dt.year() - 2000) * 12 + pl.col("date").dt.month() - 1).cast(pl.Int32).alias("ym"),
        )
        .group_by("ci", "cj", "ym", "dn", "platform")
        .agg(pl.len().cast(pl.Float64).alias("n"))
    )


def coverage(df: pl.DataFrame) -> pl.DataFrame:
    """Days with at least one detection, per platform and month (proxy for sensor availability)."""
    return df.filter(pl.col("platform").is_in(["T", "A", "N", "J1"])).with_columns(
        ((pl.col("date").dt.year() - 2000) * 12 + pl.col("date").dt.month() - 1).cast(pl.Int32).alias("ym")
    ).group_by("ym", "platform").agg(pl.col("date").n_unique().alias("days"))


def outage_months(cov: pl.DataFrame) -> dict[str, set[int]]:
    """Months in which a platform looks unavailable (instrument outage, missing granules).

    Detection-day counts are compared with the platform's OWN climatology for that calendar
    month (not with a more sensitive sensor, which would flag every quiet wet-season month).
    A month is an outage if the platform saw < 40 % of its usual detection days while the other
    MODIS/VIIRS platforms saw >= 80 % of theirs (i.e. fires were there, the sensor was not).
    """
    c = cov.with_columns((pl.col("ym") % 12).alias("moy"))
    clim = c.group_by("platform", "moy").agg(pl.col("days").median().alias("clim"))
    c = c.join(clim, on=["platform", "moy"]).with_columns((pl.col("days") / pl.col("clim")).alias("rel"))
    rel = {(p, ym): r for p, ym, r in c.select("platform", "ym", "rel").iter_rows()}
    months = sorted(set(c["ym"].to_list()))
    out: dict[str, set[int]] = {p: set() for p in ("T", "A", "N", "J1")}
    first = dict(c.group_by("platform").agg(pl.col("ym").min()).iter_rows())
    alive = {p: (first.get(p, 10**6), 10**6) for p in out}
    for ym in months:
        for p in out:
            lo, hi = alive[p]
            if not (lo <= ym < hi):
                continue
            r = rel.get((p, ym), 0.0)
            others = [rel.get((q, ym)) for q in out if q != p and alive[q][0] <= ym and rel.get((q, ym)) is not None]
            if r < 0.4 and (not others or max(others) >= 0.8):
                out[p].add(ym)
    return out


def valid_months(cov: pl.DataFrame, a: str, b: str, outages: dict[str, set[int]]) -> set[int]:
    """Months where both platforms observed (no outage on either)."""
    have = cov.filter(pl.col("platform").is_in([a, b])).group_by("ym").agg(pl.col("platform").n_unique().alias("k"))
    both = set(have.filter(pl.col("k") == 2)["ym"].to_list())
    return both - outages[a] - outages[b]


def pair(agg: pl.DataFrame, ref: str, src: str, window: tuple[int, int], months: set[int] | None = None) -> pl.DataFrame:
    """Wide table of reference (M) and source (V) counts in the overlap window."""
    w = agg.filter(pl.col("ym").is_between(*window) & pl.col("platform").is_in([ref, src]))
    if months is not None:
        w = w.filter(pl.col("ym").is_in(list(months)))
    wide = w.pivot(on="platform", index=["ci", "cj", "ym", "dn"], values="n")
    for p in (ref, src):
        wide = wide.with_columns((pl.col(p).fill_null(0.0) if p in wide.columns else pl.lit(0.0)).alias(p))
    return wide.rename({ref: "M", src: "V"}).with_columns(
        (pl.col("ym") % 12 + 1).alias("moy"),
        (pl.col("ci") // CAL_K).cast(pl.Int32).alias("ki"),
        (pl.col("cj") // CAL_K).cast(pl.Int32).alias("kj"),
    )


# ----------------------------------------------------------------------------- 3
class Calibration:
    """Ratio model E[M | V] = r[dn, moy] * theta[k, dn] * V."""

    def __init__(self, seasonal: bool = True, eb: bool = True, a0: float = A0):
        self.seasonal, self.eb, self.a0 = seasonal, eb, a0

    def fit(self, tr: pl.DataFrame) -> "Calibration":
        tot = tr.group_by("dn").agg(pl.col("M").sum(), pl.col("V").sum())
        tot_all = tr.select(pl.col("M").sum(), pl.col("V").sum()).row(0)
        self.r_all = tot_all[0] / max(tot_all[1], 1e-9)
        self.pooled_dn = set()
        r = {}
        for dn, m, v in tot.iter_rows():
            if dn == "N" and m < MIN_NIGHT:
                self.pooled_dn.add("N")
            r[dn] = m / v if v > 0 else self.r_all
        for dn in self.pooled_dn:
            r[dn] = self.r_all
        self.r = r
        # seasonal ratio, shrunk to the annual ratio
        s = tr.group_by("dn", "moy").agg(pl.col("M").sum(), pl.col("V").sum())
        rm = {}
        for dn, moy, m, v in s.iter_rows():
            base = r.get(dn, self.r_all)
            if not self.seasonal or dn in self.pooled_dn:
                rm[(dn, moy)] = base
            else:
                rm[(dn, moy)] = (m + self.a0 * base) / (v + self.a0)
        self.rm = rm
        # empirical-Bayes multiplier per calibration cell
        self.theta, self.zbar = {}, {}
        if self.eb:
            e = tr.with_columns(
                pl.struct("dn", "moy").map_elements(lambda x: self.ratio(x["dn"], x["moy"]), return_dtype=pl.Float64).alias("rr")
            ).with_columns((pl.col("rr") * pl.col("V")).alias("E"))
            k = e.group_by("ki", "kj", "dn").agg(pl.col("M").sum().alias("O"), pl.col("E").sum())
            k = k.filter(pl.col("E") > 0)
            for dn in k["dn"].unique().to_list():
                kk = k.filter(pl.col("dn") == dn)
                O, E = kk["O"].to_numpy(), kk["E"].to_numpy()
                zb = O.sum() / E.sum()
                Eb = E.mean()
                z = O / E
                s2 = (E * (z - zb) ** 2).sum() / E.sum()
                tau2 = max(s2 - zb / Eb, 1e-9)
                alpha = zb ** 2 / tau2
                th = (O + alpha) / (E + alpha / zb)
                self.zbar[dn] = float(zb)
                for ki, kj, t in zip(kk["ki"].to_list(), kk["kj"].to_list(), th):
                    self.theta[(ki, kj, dn)] = float(t)
        return self

    def ratio(self, dn: str, moy: int) -> float:
        return self.rm.get((dn, moy), self.r.get(dn, self.r_all))

    def apply(self, wide: pl.DataFrame, col: str = "V") -> pl.Series:
        """Predicted reference counts for rows with ci, cj, dn, moy and a source column."""
        rr = np.array([self.ratio(dn, moy) for dn, moy in zip(wide["dn"].to_list(), wide["moy"].to_list())])
        if self.eb:
            th = np.array([
                self.theta.get((int(ci) // CAL_K, int(cj) // CAL_K, dn), self.zbar.get(dn, 1.0))
                for ci, cj, dn in zip(wide["ci"].to_list(), wide["cj"].to_list(), wide["dn"].to_list())
            ])
        else:
            th = 1.0
        return pl.Series(rr * th * wide[col].to_numpy())

    def summary(self) -> dict:
        th = np.array(list(self.theta.values())) if self.theta else np.array([1.0])
        return {
            "ratio_day": round(self.r.get("D", self.r_all), 4),
            "ratio_night": round(self.r.get("N", self.r_all), 4),
            "night_pooled": bool(self.pooled_dn),
            "seasonal": {dn: [round(self.ratio(dn, m), 4) for m in range(1, 13)] for dn in ("D", "N")},
            "theta_quantiles": [round(float(q), 3) for q in np.quantile(th, [0.05, 0.25, 0.5, 0.75, 0.95])],
            "n_cal_cells": len(self.theta),
        }


# ----------------------------------------------------------------------------- 5
def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1]) if len(a) > 2 else float("nan")


def metrics(obs: np.ndarray, pred: np.ndarray) -> dict:
    lo, lp = np.log1p(obs), np.log1p(pred)
    ss = ((lo - lo.mean()) ** 2).sum()
    return {
        "bias_pct": round(float(pred.sum() / obs.sum() - 1) * 100, 2) if obs.sum() else None,
        "mae_log1p": round(float(np.abs(lo - lp).mean()), 4),
        "r2_log1p": round(float(1 - ((lo - lp) ** 2).sum() / ss), 4) if ss else None,
        "spearman": round(spearman(obs, pred), 4),
        "n": int(len(obs)),
    }


MODELS = {
    "N0_no_harmonization": dict(kind="identity", dedup=False),
    "N1_single_ratio_raw_pixels": dict(kind="ratio", dedup=False, seasonal=False, eb=False),
    "M1_dedup_regional_ratio": dict(kind="ratio", dedup=True, seasonal=False, eb=False),
    "M2_dedup_seasonal_ratio": dict(kind="ratio", dedup=True, seasonal=True, eb=False),
    "M3_dedup_seasonal_eb (adopted)": dict(kind="ratio", dedup=True, seasonal=True, eb=True),
}


def loyo(pairs: dict[bool, pl.DataFrame]) -> tuple[dict, pl.DataFrame]:
    """Leave-one-year-out CV of every model. Returns metrics and residual table of the adopted model."""
    res: dict[str, dict] = {}
    adopted_rows = []
    years = sorted(set((pairs[True]["ym"] // 12 + 2000).to_list()))
    for name, spec in MODELS.items():
        tab = pairs[spec["dedup"]]
        region_obs, region_pred, cell_obs, cell_pred = [], [], [], []
        for y in years:
            test = tab.filter(pl.col("ym") // 12 + 2000 == y)
            if test.height == 0:
                continue
            if spec["kind"] == "identity":
                pred = test["V"]
            else:
                train = tab.filter(pl.col("ym") // 12 + 2000 != y)
                cal = Calibration(seasonal=spec["seasonal"], eb=spec["eb"]).fit(train)
                pred = cal.apply(test)
            t = test.with_columns(pred.alias("P"))
            # observed is always the deduplicated Aqua count, so all models are scored on the same target
            if not spec["dedup"]:
                t = t.drop("M").join(pairs[True].select("ci", "cj", "ym", "dn", "M"), on=["ci", "cj", "ym", "dn"], how="left").with_columns(pl.col("M").fill_null(0.0))
            reg = t.group_by("ym").agg(pl.col("M").sum(), pl.col("P").sum())
            region_obs += reg["M"].to_list(); region_pred += reg["P"].to_list()
            cm = t.group_by("ki", "kj", "ym").agg(pl.col("M").sum(), pl.col("P").sum())
            cell_obs += cm["M"].to_list(); cell_pred += cm["P"].to_list()
            if "adopted" in name:
                adopted_rows.append(reg.with_columns(pl.lit("region").alias("level")))
                adopted_rows.append(cm.select("ym", "M", "P").with_columns(pl.lit("cell").alias("level")))
        ro, rp = np.array(region_obs), np.array(region_pred)
        co, cp = np.array(cell_obs), np.array(cell_pred)
        res[name] = {"region_month": metrics(ro, rp), "cell_month_0p5deg": metrics(co, cp)}
    return res, pl.concat(adopted_rows)


def loyo_simple(tab: pl.DataFrame) -> dict | None:
    """Leave-one-year-out for the adopted model only (used for short overlaps)."""
    ro, rp = [], []
    for y in sorted(set((tab["ym"] // 12 + 2000).to_list())):
        test, train = tab.filter(pl.col("ym") // 12 + 2000 == y), tab.filter(pl.col("ym") // 12 + 2000 != y)
        if not test.height or not train.height:
            continue
        t = test.with_columns(Calibration().fit(train).apply(test).alias("P")).group_by("ym").agg(pl.col("M").sum(), pl.col("P").sum())
        ro += t["M"].to_list()
        rp += t["P"].to_list()
    return {"region_month": metrics(np.array(ro), np.array(rp))} if ro else None


def uncertainty_bins(resid: pl.DataFrame) -> list[dict]:
    """Empirical 5-95 % ratio obs/pred by predicted magnitude (used for AOI prediction intervals)."""
    edges = [0, 3, 10, 30, 100, 300, 1000, 3000, 1e12]
    out = []
    r = resid.filter(pl.col("P") > 0.5)
    for lo, hi in zip(edges[:-1], edges[1:]):
        b = r.filter((pl.col("P") >= lo) & (pl.col("P") < hi))
        if b.height < 20:
            continue
        q = ((b["M"] + 0.5) / (b["P"] + 0.5)).to_numpy()
        out.append({"lo": lo, "hi": hi if hi < 1e12 else None, "n": b.height,
                    "q05": round(float(np.quantile(q, 0.05)), 3), "q95": round(float(np.quantile(q, 0.95)), 3)})
    return out


# ----------------------------------------------------------------------------- 4
def assemble(agg: pl.DataFrame, cal_t: Calibration, cal_v: Calibration, fallback: dict[int, str] | None = None,
             cal_j: Calibration | None = None) -> pl.DataFrame:
    """Harmonized (Aqua-equivalent) counts per GRID cell and month, plus raw AFCD per platform.
    ``fallback`` maps VIIRS-era months without usable S-NPP data to 'J1' (NOAA-20 through the
    nested NOAA-20 -> S-NPP -> Aqua ratio) or 'A' (observed Aqua)."""
    fb = fallback or {}
    fb_a = [m for m, p in fb.items() if p == "A"]
    fb_j = [m for m, p in fb.items() if p == "J1"]
    wide = agg.pivot(on="platform", index=["ci", "cj", "ym", "dn"], values="n")
    for p in ("T", "A", "N", "J1"):
        wide = wide.with_columns((pl.col(p).fill_null(0.0) if p in wide.columns else pl.lit(0.0)).alias(p))
    wide = wide.with_columns((pl.col("ym") % 12 + 1).alias("moy"))
    nj = cal_j.apply(wide, "J1") if cal_j is not None else pl.Series([0.0] * wide.height)
    wide = wide.with_columns(nj.alias("NJ"))
    wide = wide.with_columns(cal_t.apply(wide, "T").alias("HT"), cal_v.apply(wide, "N").alias("HV"),
                             cal_v.apply(wide, "NJ").alias("HJ")).with_columns(
        pl.when(pl.col("ym") < AQUA_START).then(pl.col("HT"))
        .when((pl.col("ym") < VIIRS_ERA) | pl.col("ym").is_in(fb_a)).then(pl.col("A"))
        .when(pl.col("ym").is_in(fb_j)).then(pl.col("HJ"))
        .otherwise(pl.col("HV")).alias("H")
    )
    return wide.group_by("ci", "cj", "ym").agg(
        pl.col("H").sum(), pl.col("T").sum(), pl.col("A").sum(), pl.col("N").sum(), pl.col("J1").sum(), pl.col("HV").sum()
    ).filter(pl.col("ym") >= YM0).sort("ci", "cj", "ym")


def harmonize_region(name: str) -> dict:
    df = pl.read_parquet(CACHE / f"{name}.parquet")
    today = dt.datetime.now(dt.timezone.utc).date()
    df = df.filter(pl.col("date") < today)  # today's NRT granules are still arriving
    agg = afcd(df)
    rawp = raw_pixels(df)
    last_date = df["date"].max()
    ym_last = (last_date.year - 2000) * 12 + last_date.month - 1

    # --- calibration fits
    cov = coverage(df)
    outages = outage_months(cov)
    ok_v, ok_t = valid_months(cov, "A", "N", outages), valid_months(cov, "A", "T", outages)
    pv = {True: pair(agg, "A", "N", VIIRS_CAL, ok_v), False: pair(rawp, "A", "N", VIIRS_CAL, ok_v)}
    cal_v = Calibration().fit(pv[True])
    pt = pair(agg, "A", "T", TERRA_CAL, ok_t)
    cal_t = Calibration().fit(pt)

    # --- validation
    cv, resid = loyo(pv)
    bins = uncertainty_bins(resid)
    cv_t, resid_t = loyo({True: pt, False: pair(rawp, "A", "T", TERRA_CAL, ok_t)})
    bins_t = uncertainty_bins(resid_t)

    # --- VIIRS-era months where S-NPP is missing but Aqua observed -> fall back to Aqua
    # --- NOAA-20 -> S-NPP nested calibration (S-NPP is being retired; LANCE moves to NOAA-20/21)
    cal_j, cv_j = None, None
    if agg.filter(pl.col("platform") == "J1").height:
        ok_j = valid_months(cov, "N", "J1", outages)
        pj = pair(agg, "N", "J1", (J1_CAL_START, ym_last - 1), ok_j)
        if pj.height:
            cal_j = Calibration().fit(pj)
            cv_j = loyo_simple(pj)
    days_by = {(ym_, p): d for ym_, p, d in cov.select("ym", "platform", "days").iter_rows()}
    fallback: dict[int, str] = {}
    for ym in range(VIIRS_ERA, ym_last + 1):
        ref_days = max(days_by.get((ym, "J1"), 0), days_by.get((ym, "A"), 0))
        if ym not in outages["N"] and days_by.get((ym, "N"), 0) >= 0.6 * ref_days:
            continue
        if cal_j is not None and days_by.get((ym, "J1"), 0) > 0 and ym not in outages["J1"]:
            fallback[ym] = "J1"
        elif ym not in outages["A"]:
            fallback[ym] = "A"

    # --- assemble harmonized series per cell-month
    cells = assemble(agg, cal_t, cal_v, fallback, cal_j)

    # --- same-days-of-month history for the latest (partial) month
    month_end = (dt.date(last_date.year + (last_date.month == 12), last_date.month % 12 + 1, 1) - dt.timedelta(days=1)).day
    partial_day = last_date.day if last_date.day < month_end else None
    if partial_day:
        sub = df.filter((pl.col("date").dt.month() == last_date.month) & (pl.col("date").dt.day() <= partial_day))
        part = assemble(afcd(sub), cal_t, cal_v, fallback, cal_j).with_columns((pl.col("ym") // 12 + 2000).alias("year")).select("ci", "cj", "year", "H")
    else:
        part = pl.DataFrame(schema={"ci": pl.Int32, "cj": pl.Int32, "year": pl.Int32, "H": pl.Float64})

    # VIIRS-equivalent conversion factor per calendar month (sum S-NPP / sum Aqua AFCD in the overlap)
    ov = pv[True].group_by("moy").agg(pl.col("M").sum(), pl.col("V").sum()).sort("moy")
    tot_ratio = float(pv[True]["V"].sum() / max(pv[True]["M"].sum(), 1))
    veq = {m: (v + 50 * tot_ratio) / (mm + 50) for m, mm, v in ov.iter_rows()}
    viirs_eq_factor = [round(veq.get(m, tot_ratio), 4) for m in range(1, 13)]

    # --- region-level diagnostics
    reg = cells.group_by("ym").agg(pl.col("H").sum(), pl.col("T").sum(), pl.col("A").sum(), pl.col("N").sum(), pl.col("HV").sum()).sort("ym")
    rawreg = rawp.group_by("ym", "platform").agg(pl.col("n").sum()).pivot(on="platform", index="ym", values="n").sort("ym").fill_null(0)
    drift = []
    for y in range(2021, last_date.year + 1):
        r = reg.filter((pl.col("ym") // 12 + 2000 == y) & (pl.col("ym") >= VIIRS_ERA) & (pl.col("ym") < ym_last))
        if r.height and r["HV"].sum() > 0:
            drift.append({"year": y, "aqua_over_viirs_harmonized": round(float(r["A"].sum() / r["HV"].sum()), 3)})

    # data completeness: the platform used for a month had an outage
    flags = []
    for ym in range(YM0, ym_last + 1):
        used = "T" if ym < AQUA_START else ("A" if ym < VIIRS_ERA else fallback.get(ym, "N"))
        if ym in outages[used]:
            flags.append({"ym": ym, "month": ym_to_str(ym), "platform": used})

    OUT.mkdir(exist_ok=True)
    (OUT / name).mkdir(exist_ok=True)
    cells.write_parquet(OUT / name / "cells.parquet")
    part.write_parquet(OUT / name / "partial.parquet")
    reg.join(rawreg.rename({c: f"raw_{c}" for c in rawreg.columns if c != "ym"}), on="ym", how="left").write_csv(OUT / name / "region_monthly.csv")

    report = {
        "region": name,
        "last_date": last_date.isoformat(),
        "ym_last": ym_last,
        "n_detections": df.height,
        "n_detections_by_platform": dict(df.group_by("platform").len().iter_rows()),
        "calibration_viirs_to_aqua": cal_v.summary(),
        "calibration_terra_to_aqua": cal_t.summary(),
        "raw_pixel_ratio_viirs_over_aqua": round(float(pv[False]["V"].sum() / max(pv[False]["M"].sum(), 1)), 3),
        "afcd_ratio_viirs_over_aqua": round(float(pv[True]["V"].sum() / max(pv[True]["M"].sum(), 1)), 3),
        "calibration_months": {"viirs": len(ok_v), "terra": len(ok_t)},
        "outage_months": {p: [ym_to_str(m) for m in sorted(v)] for p, v in outages.items()},
        "validation_viirs_loyo": cv,
        "validation_terra_loyo": cv_t,
        "uncertainty_bins_viirs": bins,
        "uncertainty_bins_terra": bins_t,
        "drift_diagnostic": drift,
        "incomplete_months": flags,
        "partial_day": partial_day,
        "fallback_months": {ym_to_str(m): p for m, p in sorted(fallback.items())},
        "calibration_noaa20_to_snpp": cal_j.summary() if cal_j is not None else None,
        "validation_noaa20_loyo": cv_j,
        "viirs_eq_factor": viirs_eq_factor,
        "eras": {"aqua_start": AQUA_START, "viirs_start": VIIRS_ERA, "ym0": YM0},
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    (OUT / name / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ("region", "last_date", "raw_pixel_ratio_viirs_over_aqua", "afcd_ratio_viirs_over_aqua")}, indent=1))
    for m, v in cv.items():
        print(f"  {m:34s} region {v['region_month']}\n  {'':34s} cell   {v['cell_month_0p5deg']}")
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("regions", nargs="*", default=["Philippines"])
    for r in ap.parse_args().regions:
        harmonize_region(r)
