"""Unit tests on a tiny, hand-made SYNTHETIC fixture (not real BTS data).
Every expected number below can be checked by hand.     Run:  python -m pytest -q"""
import zipfile

import pandas as pd
import pytest

import metrics as m
import pipeline as p
import risk as r

# SYNTHETIC FIXTURE - invented rows using the BTS web-form column style (FL_DATE, CRS_DEP_TIME ...)
SYNTHETIC_CSV = """FL_DATE,OP_UNIQUE_CARRIER,OP_CARRIER_FL_NUM,ORIGIN,DEST,CRS_DEP_TIME,DEP_TIME,DEP_DELAY,CANCELLED,CANCELLATION_CODE,DIVERTED,CARRIER_DELAY,WEATHER_DELAY,NAS_DELAY,SECURITY_DELAY,LATE_AIRCRAFT_DELAY
2026-07-01,UA,1,ORD,LGA,0005,0030,25.00,0.00,,0.00,0.00,25.00,0.00,0.00,0.00
2026-07-01,UA,2,ORD,LGA,1430,1444,14.00,0.00,,0.00,,,,,
2026-07-01,AA,3,ORD,DFW,2400,0015,15.00,0.00,,0.00,,,,,
2026-07-01,AA,4,ORD,DFW,0900,,,1.00,B,0.00,,,,,
2026-07-01,AA,5,ORD,DFW,0910,,,0.00,,0.00,,,,,
2026-07-01,DL,6,ATL,ORD,0800,0900,60.00,0.00,,0.00,60.00,0.00,0.00,0.00,0.00
"""


@pytest.fixture
def cleaned(tmp_path):
    path = tmp_path / "synthetic.csv"
    path.write_text(SYNTHETIC_CSV)
    return p.clean(p.read_bts_file(path, "ORD"))


def test_filters_to_airport_departures(cleaned):
    assert len(cleaned) == 5                     # the ATL->ORD row is an arrival, dropped
    assert set(cleaned["origin"]) == {"ORD"}


def test_hhmm_parsing():
    assert p.hhmm_to_hour(pd.Series(["0005", "1430", "2400", "59"])).tolist() == [0, 14, 0, 0]


def test_delay_definition_and_denominator(cleaned):
    k = m.kpis(cleaned)
    assert k["scheduled"] == 5
    assert k["cancelled"] == 1                   # flight 4
    assert k["missing_outcome"] == 1             # flight 5: not cancelled, no departure delay
    assert k["operated"] == 3                    # flights 1, 2, 3
    assert k["delayed"] == 2                     # 25 min and exactly 15 min count; 14 min does not
    assert k["delay_rate"] == pytest.approx(2 / 3)


def test_reason_data_count(cleaned):
    reasons, n = m.reason_summary(cleaned)
    assert n == 1
    assert reasons.set_index("reason").loc["Weather", "minutes"] == 25


def test_zip_input_and_column_aliases(tmp_path):
    z = tmp_path / "synthetic.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("inner.csv", SYNTHETIC_CSV)
    assert len(p.read_bts_file(z, "ORD")) == 5


def _synthetic_three_months():
    """SYNTHETIC: 3 months, destination A is always delayed in the evening, B never."""
    rows = []
    for month in ["2026-07", "2026-08", "2026-09"]:
        for day in range(1, 11):
            for i in range(8):
                dest, hour = ("A", 19) if i < 4 else ("B", 7)
                rows.append({"flight_date": pd.Timestamp(f"{month}-{day:02d}"), "month": month,
                             "dest": dest, "sched_hour": hour, "cancelled": False,
                             "missing_outcome": False, "operated": True, "delayed_15": dest == "A"})
    rows.append({**rows[0], "dest": "RARE"})       # a destination with only 1 training flight
    df = pd.DataFrame(rows)
    df["band"] = r.time_band(df["sched_hour"])
    return df


def test_month_split_and_fallback():
    df = _synthetic_three_months()
    train_months, holdout = r.split_months(df)
    assert train_months == ["2026-07", "2026-08"] and holdout == "2026-09"
    train = df[df["month"].isin(train_months)]
    rates = r.fit_rates(train, min_n=30)
    probe = pd.DataFrame({"dest": ["A", "B", "RARE", "NEW"],
                          "band": r.time_band(pd.Series([19, 7, 19, 3]))})
    s = r.score(probe, rates)
    assert s["risk_score"].tolist()[:2] == [1.0, 0.0]
    assert s["score_level"].tolist() == ["dest+band", "dest+band", "band fallback", "overall fallback"]


def test_roc_auc_and_wilson():
    y = pd.Series([0, 0, 1, 1])
    assert r.roc_auc(y, pd.Series([0.1, 0.2, 0.8, 0.9])) == 1.0      # perfect ranking
    assert r.roc_auc(y, pd.Series([0.9, 0.8, 0.2, 0.1])) == 0.0      # perfectly wrong
    assert r.roc_auc(y, pd.Series([0.5, 0.5, 0.5, 0.5])) == 0.5      # all tied = coin flip
    lo, hi = r.wilson(pd.Series([50]), pd.Series([100]))
    assert lo.iloc[0] == pytest.approx(0.404, abs=1e-3) and hi.iloc[0] == pytest.approx(0.596, abs=1e-3)


def test_alerts_pick_top_k_per_day_and_evaluate():
    df = _synthetic_three_months()
    rates = r.fit_rates(df[df["month"] != "2026-09"])
    scored = r.score(df[df["month"] == "2026-09"], rates)
    alerts = r.daily_alerts(scored, k=3)
    assert alerts.groupby("flight_date").size().eq(3).all()
    res = r.evaluate(scored, alerts)
    assert res["alerts_delay_rate"] == 1.0 and res["holdout_delay_rate"] == 0.5
    assert res["alerts_true_delays"] == 30
