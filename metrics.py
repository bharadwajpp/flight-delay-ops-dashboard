"""Shared metric functions. The dashboard and the tests both call these, so a number
on screen is always computed by exactly one piece of code."""
from __future__ import annotations

import pandas as pd

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
REASONS = {
    "carrier_delay": "Carrier",
    "weather_delay": "Weather",
    "nas_delay": "National Aviation System",
    "security_delay": "Security",
    "late_aircraft_delay": "Late-arriving aircraft",
}
CARRIER_NAMES = {
    "AA": "American", "AS": "Alaska", "B6": "JetBlue", "DL": "Delta", "F9": "Frontier",
    "G4": "Allegiant", "HA": "Hawaiian", "MQ": "Envoy", "NK": "Spirit", "OH": "PSA",
    "OO": "SkyWest", "UA": "United", "WN": "Southwest", "YX": "Republic", "9E": "Endeavor",
    "ZW": "Air Wisconsin", "C5": "CommuteAir", "G7": "GoJet", "QX": "Horizon", "YV": "Mesa",
    "PT": "Piedmont",
}


def kpis(df: pd.DataFrame) -> dict:
    operated = int(df["operated"].sum())
    delayed = int(df["delayed_15"].sum())
    return {
        "scheduled": len(df),
        "cancelled": int(df["cancelled"].sum()),
        "missing_outcome": int(df["missing_outcome"].sum()),
        "operated": operated,
        "delayed": delayed,
        # denominator = operated departures only (cancelled + missing outcome excluded)
        "delay_rate": delayed / operated if operated else float("nan"),
    }


def heatmap_table(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Delay rate and operated-flight count for each weekday x scheduled departure hour."""
    op = df[df["operated"]]
    g = op.groupby(["weekday", "sched_hour"])["delayed_15"].agg(["mean", "size"])
    rate = g["mean"].unstack().reindex(index=WEEKDAYS, columns=range(24))
    count = g["size"].unstack().reindex(index=WEEKDAYS, columns=range(24)).fillna(0).astype(int)
    return rate, count


def route_table(df: pd.DataFrame, min_flights: int = 0) -> pd.DataFrame:
    g = df.groupby("dest").agg(
        scheduled=("dest", "size"),
        cancelled=("cancelled", "sum"),
        operated=("operated", "sum"),
        delayed=("delayed_15", "sum"),
    )
    g["delay_rate"] = g["delayed"] / g["operated"].where(g["operated"] > 0)
    g = g[g["operated"] >= min_flights]
    return g.sort_values(["delay_rate", "operated"], ascending=False).reset_index()


def reason_summary(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Total recorded delay minutes and number of flights citing each cause.
    BTS records causes only for flights that arrived 15+ min late."""
    with_reason = df[df["has_reason_data"]]
    rows = []
    for col, label in REASONS.items():
        rows.append({
            "reason": label,
            "minutes": float(with_reason[col].fillna(0).sum()),
            "flights_citing": int((with_reason[col].fillna(0) > 0).sum()),
        })
    out = pd.DataFrame(rows)
    total = out["minutes"].sum()
    out["share_of_minutes"] = out["minutes"] / total if total else 0.0
    return out.sort_values("minutes", ascending=False), len(with_reason)


def carrier_label(code: str) -> str:
    return f"{code} - {CARRIER_NAMES[code]}" if code in CARRIER_NAMES else code
