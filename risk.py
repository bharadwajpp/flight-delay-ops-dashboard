"""Step 3 - Analytics: a simple, explainable historical risk score.

    python risk.py

1. Training period = first two months. For every (destination, departure time band)
   group, the risk is the share of operated departures that left 15+ min late.
2. Groups with fewer than MIN_GROUP_SIZE operated flights are too noisy, so they fall
   back to the broader historical rate for that time band (and, if even that is thin,
   the overall training rate).
3. Historical holdout = third month. Every scheduled flight gets a score using only
   schedule information (destination + scheduled departure time). No outcomes are used.
4. Each day, the 10 highest-scored flights become "alerts". We compare the observed
   delay rate of those alerts with the overall holdout delay rate.

Outputs: data/processed/holdout_scores.parquet and data/processed/risk_metrics.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
PROCESSED = ROOT / "data" / "processed"
MIN_GROUP_SIZE = 30
ALERTS_PER_DAY = 10
SEED = 42

# Scheduled departure hour -> band (labels sort in time order)
BANDS = [(0, 6, "1 Overnight 00-06"), (6, 9, "2 Early 06-09"), (9, 12, "3 Morning 09-12"),
         (12, 15, "4 Midday 12-15"), (15, 18, "5 Afternoon 15-18"), (18, 21, "6 Evening 18-21"),
         (21, 24, "7 Late 21-24")]


def time_band(hour: pd.Series) -> pd.Series:
    edges = [lo for lo, _, _ in BANDS] + [24]
    labels = [label for _, _, label in BANDS]
    return pd.cut(hour.astype(float), bins=edges, right=False, labels=labels).astype(str)


def split_months(df: pd.DataFrame) -> tuple[list[str], str]:
    months = sorted(df["month"].unique())
    if len(months) != 3:
        raise ValueError(f"Expected exactly 3 months, found {months}")
    return months[:2], months[2]


def fit_rates(train: pd.DataFrame, min_n: int = MIN_GROUP_SIZE) -> dict:
    """Historical delay rates at three levels of detail (operated flights only)."""
    op = train[train["operated"]]
    group = op.groupby(["dest", "band"])["delayed_15"].agg(["mean", "size"])
    band = op.groupby("band")["delayed_15"].agg(["mean", "size"])
    return {"group": group, "band": band, "overall": float(op["delayed_15"].mean()), "min_n": min_n}


def score(flights: pd.DataFrame, rates: dict) -> pd.DataFrame:
    """Attach risk_score + which level it came from. Uses only dest and scheduled time."""
    out = flights.copy()
    g = rates["group"].rename(columns={"mean": "g_rate", "size": "g_n"})
    b = rates["band"].rename(columns={"mean": "b_rate", "size": "b_n"})
    out = out.join(g, on=["dest", "band"]).join(b, on="band")
    use_group = out["g_n"].fillna(0) >= rates["min_n"]
    use_band = ~use_group & (out["b_n"].fillna(0) >= rates["min_n"])
    out["risk_score"] = np.select([use_group, use_band], [out["g_rate"], out["b_rate"]], rates["overall"])
    out["score_level"] = np.select([use_group, use_band], ["dest+band", "band fallback"], "overall fallback")
    return out.drop(columns=["g_rate", "g_n", "b_rate", "b_n"])


def daily_alerts(scored: pd.DataFrame, k: int = ALERTS_PER_DAY, seed: int = SEED) -> pd.DataFrame:
    """Top-k scored flights per day. Many flights share a score (same group), so ties are
    broken randomly with a fixed seed - reproducible, and adds no hidden information."""
    rng = np.random.default_rng(seed)
    tmp = scored.assign(_tie=rng.random(len(scored)))
    tmp = tmp.sort_values(["flight_date", "risk_score", "_tie"], ascending=[True, False, True])
    return tmp.groupby("flight_date").head(k).drop(columns="_tie")


def evaluate(scored: pd.DataFrame, alerts: pd.DataFrame) -> dict:
    op_all, op_alert = scored[scored["operated"]], alerts[alerts["operated"]]
    base = float(op_all["delayed_15"].mean())
    alert_rate = float(op_alert["delayed_15"].mean())
    return {
        "holdout_operated": int(len(op_all)),
        "holdout_delayed": int(op_all["delayed_15"].sum()),
        "holdout_delay_rate": base,
        "alerts_total": int(len(alerts)),
        "alerts_cancelled": int(alerts["cancelled"].sum()),
        "alerts_missing_outcome": int(alerts["missing_outcome"].sum()),
        "alerts_operated": int(len(op_alert)),
        "alerts_true_delays": int(op_alert["delayed_15"].sum()),
        "alerts_delay_rate": alert_rate,
        "lift_vs_holdout": alert_rate / base if base else float("nan"),
        "share_of_all_holdout_delays_caught": float(op_alert["delayed_15"].sum() / op_all["delayed_15"].sum()),
    }


def roc_auc(y: pd.Series, s: pd.Series) -> float:
    """Probability that a random delayed flight scores higher than a random on-time one
    (Mann-Whitney formulation; tied scores count as half)."""
    y = y.astype(bool).to_numpy()
    ranks = pd.Series(s.to_numpy()).rank(method="average").to_numpy()
    n_pos, n_neg = y.sum(), (~y).sum()
    return float((ranks[y].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def probability_quality(scored: pd.DataFrame, train_rate: float) -> dict:
    """How good is risk_score as a probability on the holdout (operated flights only)?"""
    op = scored[scored["operated"]]
    y, p = op["delayed_15"].astype(float), op["risk_score"].astype(float)
    brier = float(((p - y) ** 2).mean())
    brier_base = float(((train_rate - y) ** 2).mean())  # always predict the training average
    deciles = pd.qcut(p.rank(method="first"), 10, labels=False)
    calib = (op.assign(decile=deciles.to_numpy() + 1)
               .groupby("decile").agg(predicted=("risk_score", "mean"), observed=("delayed_15", "mean"),
                                      flights=("delayed_15", "size")).reset_index())
    return {
        "roc_auc": roc_auc(op["delayed_15"], op["risk_score"]),
        "brier_score": brier,
        "brier_baseline": brier_base,
        "brier_skill": 1 - brier / brier_base,
        "calibration_deciles": calib.round(4).to_dict(orient="records"),
    }


def wilson(k: pd.Series, n: pd.Series, z: float = 1.96) -> tuple[pd.Series, pd.Series]:
    """95% Wilson confidence interval for a proportion k/n (stable for small n)."""
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return centre - half, centre + half


def main() -> None:
    df = pd.read_parquet(PROCESSED / "departures.parquet")
    df["band"] = time_band(df["sched_hour"])
    train_months, holdout_month = split_months(df)
    train, holdout = df[df["month"].isin(train_months)], df[df["month"] == holdout_month]

    rates = fit_rates(train)
    scored = score(holdout, rates)
    alerts = daily_alerts(scored)
    result = evaluate(scored, alerts)

    # Robustness: does the answer depend on how ties were broken?
    seeds = [evaluate(scored, daily_alerts(scored, seed=s))["alerts_delay_rate"] for s in range(20)]

    metrics = {
        "label": "Historical risk score evaluated on a historical holdout month (not a live forecast)",
        "train_months": train_months,
        "holdout_month": holdout_month,
        "min_group_size": MIN_GROUP_SIZE,
        "alerts_per_day": ALERTS_PER_DAY,
        "train_operated": int(train["operated"].sum()),
        "train_delay_rate": rates["overall"],
        "groups_total": int(len(rates["group"])),
        "groups_meeting_min_size": int((rates["group"]["size"] >= MIN_GROUP_SIZE).sum()),
        "holdout_score_level_counts": scored["score_level"].value_counts().to_dict(),
        **result,
        "alerts_delay_rate_over_20_tie_seeds": {"min": min(seeds), "max": max(seeds), "mean": float(np.mean(seeds))},
        **probability_quality(scored, rates["overall"]),
    }
    scored["is_alert"] = scored.index.isin(alerts.index)
    scored.to_parquet(PROCESSED / "holdout_scores.parquet", index=False)
    (PROCESSED / "risk_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
