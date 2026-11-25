"""Synthetic-data tests for the harmonization model (run: python -m pytest -q)."""
import numpy as np
import polars as pl

from harmonize import Calibration, metrics


def synthetic(ratio_by_cell: dict, months=range(146, 258), seed=0):
    """Aqua counts M ~ Poisson(true_ratio * V) for cells with different true ratios."""
    rng = np.random.default_rng(seed)
    rows = []
    for (ci, cj), r in ratio_by_cell.items():
        for ym in months:
            for dn in ("D", "N"):
                season = 1 + 0.8 * np.sin(2 * np.pi * (ym % 12) / 12)
                V = rng.poisson(40 * season * (1 if dn == "D" else 0.3))
                M = rng.poisson(r * (1 if dn == "D" else 0.5) * V)
                rows.append((ci, cj, ym, dn, float(M), float(V)))
    df = pl.DataFrame(rows, schema=["ci", "cj", "ym", "dn", "M", "V"], orient="row")
    return df.with_columns((pl.col("ym") % 12 + 1).alias("moy"), (pl.col("ci") // 5).alias("ki"), (pl.col("cj") // 5).alias("kj"))


def test_recovers_regional_day_and_night_ratio():
    df = synthetic({(0, 0): 0.3, (10, 10): 0.3})
    cal = Calibration(seasonal=False, eb=False).fit(df)
    assert abs(cal.r["D"] - 0.3) < 0.02
    assert abs(cal.r["N"] - 0.15) < 0.02


def test_eb_multiplier_separates_cells_with_different_ratios():
    df = synthetic({(0, 0): 0.2, (10, 10): 0.4, (20, 20): 0.3})
    cal = Calibration(seasonal=True, eb=True).fit(df)
    pred = cal.apply(df)
    obs = df["M"].to_numpy()
    plain = Calibration(seasonal=True, eb=False).fit(df).apply(df)
    # per-cell multipliers must reduce the error versus a single regional ratio
    assert np.abs(pred.to_numpy() - obs).mean() < np.abs(plain.to_numpy() - obs).mean()


def test_metrics_perfect_prediction():
    m = metrics(np.array([1.0, 5.0, 10.0]), np.array([1.0, 5.0, 10.0]))
    assert m["bias_pct"] == 0 and m["r2_log1p"] == 1 and m["mae_log1p"] == 0
