"""Step 4 - Export the processed data for the static web app in web/ (deployed on Vercel).

    python export_web.py

Writes two compact, column-oriented JSON files. The browser does all filtering and
aggregation itself, using the same definitions as pipeline.py / metrics.py:
  web/data/flights.json  one entry per ORD departure (all three months)
  web/data/model.json    risk lookup table (with 95% intervals) + holdout scores + metrics
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import metrics as m
import risk as r

ROOT = Path(__file__).resolve().parent
PROCESSED = ROOT / "data" / "processed"
OUT = ROOT / "web" / "data"


def codes(series: pd.Series) -> tuple[list[int], list[str]]:
    cat = series.astype("category")
    return cat.cat.codes.astype(int).tolist(), [str(c) for c in cat.cat.categories]


def ints(series: pd.Series) -> list:
    """Integers with None for missing (keeps the JSON small)."""
    return [None if pd.isna(v) else int(round(v)) for v in series]


def main() -> None:
    df = pd.read_parquet(PROCESSED / "departures.parquet")
    meta = json.loads((PROCESSED / "pipeline_metadata.json").read_text())
    df["band"] = r.time_band(df["sched_hour"])

    # status: 0 on time, 1 delayed 15+, 2 cancelled, 3 missing outcome (excluded)
    status = np.select([df["cancelled"], df["missing_outcome"], df["delayed_15"]], [2, 3, 1], 0)
    date_idx, dates = codes(df["flight_date"].dt.strftime("%Y-%m-%d"))
    carrier_idx, carriers = codes(df["carrier"])
    dest_idx, dests = codes(df["dest"])
    flights = {
        "meta": {**meta, "data_through": df["flight_date"].max().strftime("%Y-%m-%d"),
                 "weekdays": m.WEEKDAYS, "carrier_names": m.CARRIER_NAMES, "reasons": list(m.REASONS.values())},
        "dict": {"dates": dates, "carriers": carriers, "dests": dests},
        "cols": {
            "d": date_idx, "c": carrier_idx, "r": dest_idx,
            "w": df["flight_date"].dt.day_of_week.tolist(),          # 0 = Monday
            "t": ints(df["crs_dep_time"]), "h": ints(df["sched_hour"]),
            "s": status.tolist(), "dd": ints(df["dep_delay"]),
            "fn": [None if pd.isna(v) else str(v) for v in df["flight_number"]],
            "hr": df["has_reason_data"].astype(int).tolist(),
            **{key: ints(df[col].where(df["has_reason_data"])) for key, col in
               zip(["rc", "rw", "rn", "rs", "rl"], m.REASONS)},
        },
    }

    # ---- model: same code path as risk.py ----
    train_months, holdout_month = r.split_months(df)
    train = df[df["month"].isin(train_months)]
    rates = r.fit_rates(train)
    holdout = df[df["month"] == holdout_month]
    scored = r.score(holdout, rates)
    alerts = r.daily_alerts(scored)
    metrics = json.loads((PROCESSED / "risk_metrics.json").read_text())

    g = rates["group"].reset_index()
    k = (g["mean"] * g["size"]).round()
    g["lo"], g["hi"] = r.wilson(k, g["size"])
    b = rates["band"].reset_index()
    kb = (b["mean"] * b["size"]).round()
    b["lo"], b["hi"] = r.wilson(kb, b["size"])
    model = {
        "metrics": metrics,
        "bands": [label for _, _, label in r.BANDS],
        "band_hours": [[lo, hi] for lo, hi, _ in r.BANDS],
        "overall_rate": rates["overall"],
        "group_rates": [[row.dest, row.band, int(row["size"]), round(float(row["mean"]), 4),
                         round(float(row.lo), 4), round(float(row.hi), 4)] for _, row in g.iterrows()],
        "band_rates": [[row.band, int(row["size"]), round(float(row["mean"]), 4),
                        round(float(row.lo), 4), round(float(row.hi), 4)] for _, row in b.iterrows()],
        "holdout": {
            "row": scored.index.tolist(),                      # row index into flights.json
            "p": scored["risk_score"].round(4).tolist(),
            "lvl": scored["score_level"].map({"dest+band": 0, "band fallback": 1, "overall fallback": 2}).tolist(),
            "alert": scored.index.isin(alerts.index).astype(int).tolist(),
        },
    }

    OUT.mkdir(parents=True, exist_ok=True)
    for name, obj in [("flights.json", flights), ("model.json", model)]:
        path = OUT / name
        path.write_text(json.dumps(obj, separators=(",", ":")))
        print(f"wrote {path.relative_to(ROOT)}  {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
