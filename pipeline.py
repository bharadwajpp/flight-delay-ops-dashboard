"""Step 1 - Engineering pipeline.

Turns official BTS "Reporting Carrier On-Time Performance" monthly files into one
clean table of ORD departures: data/processed/departures.parquet

    python pipeline.py                                 # default: Jul-Sep 2026, downloads if needed
    python pipeline.py --months 2026-07 2026-08 2026-09
    python pipeline.py --files my_export_1.csv my_export_2.zip   # use local BTS files instead

Key definitions (used everywhere else in the project):
  * scheduled  = every row BTS reports for the airport/month
  * cancelled  = Cancelled == 1                      (reported separately, never "delayed")
  * operated   = not cancelled AND departure delay is known
  * missing    = not cancelled AND departure delay is missing -> excluded from the delay-rate
                 denominator and counted in the metadata file
  * delayed    = operated AND DepDelay >= 15 minutes after the scheduled (CRS) departure
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "processed"
DEFAULT_MONTHS = ["2026-07", "2026-08", "2026-09"]
DELAY_THRESHOLD_MIN = 15

BTS_TABLE_PAGE = "https://www.transtats.bts.gov/TableInfo.asp?QO_fu146_anzr=b0-gvzr&gnoyr_VQ=FGJ"
BTS_ZIP_URL = ("https://transtats.bts.gov/PREZIP/"
               "On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{year}_{month}.zip")

# BTS uses two naming styles: the pre-zipped monthly files ("CRSDepTime") and the
# "Download" web form ("CRS_DEP_TIME"). We map both to one internal name.
COLUMN_ALIASES = {
    "flight_date": ["FlightDate", "FL_DATE"],
    "carrier": ["Reporting_Airline", "OP_UNIQUE_CARRIER", "OP_CARRIER"],
    "flight_number": ["Flight_Number_Reporting_Airline", "OP_CARRIER_FL_NUM"],
    "tail_number": ["Tail_Number", "TAIL_NUM"],
    "origin": ["Origin", "ORIGIN"],
    "dest": ["Dest", "DEST"],
    "crs_dep_time": ["CRSDepTime", "CRS_DEP_TIME"],
    "dep_time": ["DepTime", "DEP_TIME"],
    "dep_delay": ["DepDelay", "DEP_DELAY"],
    "cancelled": ["Cancelled", "CANCELLED"],
    "cancellation_code": ["CancellationCode", "CANCELLATION_CODE"],
    "diverted": ["Diverted", "DIVERTED"],
    "carrier_delay": ["CarrierDelay", "CARRIER_DELAY"],
    "weather_delay": ["WeatherDelay", "WEATHER_DELAY"],
    "nas_delay": ["NASDelay", "NAS_DELAY"],
    "security_delay": ["SecurityDelay", "SECURITY_DELAY"],
    "late_aircraft_delay": ["LateAircraftDelay", "LATE_AIRCRAFT_DELAY"],
}
REQUIRED = ["flight_date", "carrier", "origin", "dest", "crs_dep_time", "dep_delay", "cancelled"]
REASON_COLS = ["carrier_delay", "weather_delay", "nas_delay", "security_delay", "late_aircraft_delay"]
_LOOKUP = {alias.lower(): name for name, aliases in COLUMN_ALIASES.items() for alias in aliases}


def hhmm_to_hour(value: pd.Series) -> pd.Series:
    """BTS stores clock times as hhmm numbers: 5 -> 00:05, 1430 -> 14:30, 2400 -> midnight.
    Returns the hour 0-23 (2400 becomes 0)."""
    num = pd.to_numeric(value, errors="coerce")
    return ((num // 100) % 24).astype("Int64")


def read_bts_file(path: Path, airport: str, chunksize: int = 250_000) -> pd.DataFrame:
    """Read one BTS CSV (or a ZIP containing one), keep only departures from `airport`."""
    def pick(col: str) -> bool:
        return col.strip().lower() in _LOOKUP

    def read(handle) -> pd.DataFrame:
        parts = []
        for chunk in pd.read_csv(handle, usecols=pick, dtype=str, chunksize=chunksize):
            chunk = chunk.rename(columns=lambda c: _LOOKUP[c.strip().lower()])
            parts.append(chunk[chunk["origin"].str.strip() == airport])
        return pd.concat(parts, ignore_index=True)

    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not csv_names:
                raise ValueError(f"{path.name}: no CSV inside the ZIP")
            with zf.open(csv_names[0]) as handle:
                df = read(handle)
    else:
        df = read(path)

    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"{path.name}: missing required BTS columns {missing}")
    df["source_file"] = path.name
    return df


def clean(df: pd.DataFrame) -> pd.DataFrame:
    """Type conversion + the delay / cancellation / exclusion flags."""
    def optional(col: str) -> pd.Series:
        return df[col] if col in df.columns else pd.Series(pd.NA, index=df.index, dtype="string")

    def flag(col: str) -> pd.Series:  # BTS flags are "1.00" / "0.00"
        return pd.to_numeric(optional(col), errors="coerce").fillna(0).astype(int) == 1

    out = pd.DataFrame({
        "flight_date": pd.to_datetime(df["flight_date"], errors="coerce"),
        "carrier": df["carrier"].str.strip(),
        "flight_number": optional("flight_number"),
        "tail_number": optional("tail_number"),
        "origin": df["origin"].str.strip(),
        "dest": df["dest"].str.strip(),
        "crs_dep_time": pd.to_numeric(df["crs_dep_time"], errors="coerce").astype("Int64"),
        "dep_delay": pd.to_numeric(df["dep_delay"], errors="coerce"),
        "cancelled": flag("cancelled"),
        "cancellation_code": optional("cancellation_code"),
        "diverted": flag("diverted"),
        "source_file": df["source_file"],
    })
    for col in REASON_COLS:
        out[col] = pd.to_numeric(df[col], errors="coerce") if col in df.columns else float("nan")

    out = out.dropna(subset=["flight_date", "crs_dep_time"])
    out["month"] = out["flight_date"].dt.strftime("%Y-%m")
    out["weekday"] = out["flight_date"].dt.day_name()
    out["sched_hour"] = hhmm_to_hour(out["crs_dep_time"])

    out["missing_outcome"] = ~out["cancelled"] & out["dep_delay"].isna()
    out["operated"] = ~out["cancelled"] & out["dep_delay"].notna()
    out["delayed_15"] = out["operated"] & (out["dep_delay"] >= DELAY_THRESHOLD_MIN)
    # BTS only fills the five reason columns for flights that ARRIVED 15+ min late.
    out["has_reason_data"] = out[REASON_COLS].notna().any(axis=1)
    return out.sort_values(["flight_date", "crs_dep_time"]).reset_index(drop=True)


def download_month(month: str) -> Path:
    year, mon = month.split("-")
    target = RAW_DIR / f"bts_{year}_{mon}.zip"
    if target.exists() and target.stat().st_size > 0:
        print(f"  using cached {target.name}")
        return target
    url = BTS_ZIP_URL.format(year=year, month=int(mon))
    print(f"  downloading {url}")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    try:
        tmp = target.with_suffix(".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.replace(target)
    except Exception as exc:  # network blocked, 404, etc.
        sys.exit(
            f"\nCould not download {month} ({exc}).\n"
            f"Get the file manually and re-run with --files:\n"
            f"  1. Open {BTS_TABLE_PAGE}\n"
            f"  2. Click 'Download', choose year {year} / month {int(mon)}, tick the fields "
            f"FlightDate, Reporting_Airline, Origin, Dest, CRSDepTime, DepTime, DepDelay, "
            f"Cancelled, CancellationCode, Diverted and the five *Delay cause fields\n"
            f"  3. Save the ZIP into {RAW_DIR} and run: python pipeline.py --files data/raw/<file>.zip ...\n"
        )
    return target


def month_is_published(month: str) -> bool:
    year, mon = month.split("-")
    req = urllib.request.Request(BTS_ZIP_URL.format(year=year, month=int(mon)), method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except Exception:
        return False


def latest_three_months(today: pd.Timestamp | None = None) -> list[str]:
    """Newest month BTS has published (it lags 2-3 months), plus the two before it."""
    current = (today or pd.Timestamp.today()).to_period("M")
    for back in range(1, 13):
        month = str(current - back)
        if month_is_published(month):
            return [str(pd.Period(month) - i) for i in (2, 1, 0)]
    sys.exit("No BTS month found in the last 12 months - is transtats.bts.gov reachable?")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--months", nargs="+", default=DEFAULT_MONTHS, help="YYYY-MM, three consecutive months")
    parser.add_argument("--latest", action="store_true", help="use the newest three months BTS has published")
    parser.add_argument("--files", nargs="+", type=Path, help="local BTS CSV/ZIP files (skips download)")
    parser.add_argument("--airport", default="ORD")
    args = parser.parse_args()

    if args.latest and not args.files:
        args.months = latest_three_months()
        print(f"  latest published BTS months: {args.months}")
    files = args.files or [download_month(m) for m in args.months]
    frames = []
    for f in files:
        print(f"  reading {f.name}")
        frames.append(read_bts_file(Path(f), args.airport))
    df = clean(pd.concat(frames, ignore_index=True))

    months = sorted(df["month"].unique())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT_DIR / "departures.parquet", index=False)

    meta = {
        "airport": args.airport,
        "months": months,
        "source": "BTS Reporting Carrier On-Time Performance (1987-present), " + BTS_TABLE_PAGE,
        "source_files": [Path(f).name for f in files],
        "built_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "delay_definition": f"operated departure with DepDelay >= {DELAY_THRESHOLD_MIN} min vs scheduled",
        "per_month": {
            m: {
                "scheduled": int(len(g)),
                "cancelled": int(g["cancelled"].sum()),
                "missing_outcome_excluded": int(g["missing_outcome"].sum()),
                "operated": int(g["operated"].sum()),
                "delayed_15": int(g["delayed_15"].sum()),
                "with_reason_data": int(g["has_reason_data"].sum()),
            }
            for m, g in df.groupby("month")
        },
    }
    (OUT_DIR / "pipeline_metadata.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta["per_month"], indent=2))
    print(f"Wrote {len(df):,} {args.airport} departures for {months} to {OUT_DIR / 'departures.parquet'}")


if __name__ == "__main__":
    main()
