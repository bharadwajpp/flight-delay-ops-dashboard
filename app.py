"""Step 2 - Digital: one Streamlit dashboard.   Run:  streamlit run app.py"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

import metrics as m

PROCESSED = Path(__file__).resolve().parent / "data" / "processed"
MIN_CELL = 10  # heatmap cells with fewer operated flights are left blank (too noisy)

st.set_page_config(page_title="Flight Delay Operations Dashboard", layout="wide")


@st.cache_data
def load():
    if not (PROCESSED / "departures.parquet").exists():
        return None
    flights = pd.read_parquet(PROCESSED / "departures.parquet")
    meta = json.loads((PROCESSED / "pipeline_metadata.json").read_text())
    scores = risk = None
    if (PROCESSED / "risk_metrics.json").exists():
        scores = pd.read_parquet(PROCESSED / "holdout_scores.parquet")
        risk = json.loads((PROCESSED / "risk_metrics.json").read_text())
    return flights, meta, scores, risk


data = load()
if data is None:
    st.error("No processed data yet. Run `python pipeline.py` then `python risk.py`.")
    st.stop()
flights, meta, scores, risk = data

st.title("Flight Delay Operations Dashboard")
st.caption(
    f"{meta['airport']} departures, {', '.join(meta['months'])} - source: {meta['source']}. "
    f"Delayed = {meta['delay_definition']}."
)

# ---------------- sidebar filters ----------------
st.sidebar.header("Filters")
dmin, dmax = flights["flight_date"].min().date(), flights["flight_date"].max().date()
picked = st.sidebar.date_input("Flight dates", (dmin, dmax), min_value=dmin, max_value=dmax)
start, end = (picked if isinstance(picked, (list, tuple)) and len(picked) == 2 else (dmin, dmax))
carriers = sorted(flights["carrier"].unique())
chosen = st.sidebar.multiselect("Carriers (empty = all)", carriers, format_func=m.carrier_label)
st.sidebar.caption("Filters apply to tabs 1-2. Tab 3 is a fixed evaluation of the holdout month.")

view = flights[(flights["flight_date"].dt.date >= start) & (flights["flight_date"].dt.date <= end)]
if chosen:
    view = view[view["carrier"].isin(chosen)]
if view.empty:
    st.warning("No flights match these filters.")
    st.stop()

tab1, tab2, tab3 = st.tabs(["1 - When are departures late?", "2 - Routes & recorded reasons",
                            "3 - Historical risk watchlist"])

# ---------------- tab 1: KPIs + heatmap ----------------
with tab1:
    k = m.kpis(view)
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Scheduled departures", f"{k['scheduled']:,}")
    c2.metric("Cancelled", f"{k['cancelled']:,}", f"{k['cancelled'] / k['scheduled']:.1%} of scheduled",
              delta_color="off")
    c3.metric("Operated departures", f"{k['operated']:,}")
    c4.metric("Delayed 15+ min", f"{k['delay_rate']:.1%}", f"{k['delayed']:,} of {k['operated']:,} operated",
              delta_color="off")
    st.caption(f"Delay-rate denominator = operated departures. Excluded: {k['cancelled']:,} cancelled and "
               f"{k['missing_outcome']:,} non-cancelled flights with no recorded departure outcome.")

    rate, count = m.heatmap_table(view)
    z = (rate * 100).where(count >= MIN_CELL).round(1)
    fig = go.Figure(go.Heatmap(
        z=z.values, x=[f"{h:02d}:00" for h in z.columns], y=z.index, customdata=count.values,
        colorscale="OrRd", zmin=0, colorbar=dict(title="% delayed"),
        hovertemplate="%{y} %{x}<br>%{z:.1f}% delayed<br>%{customdata} operated flights<extra></extra>",
    ))
    fig.update_layout(title="Share of operated departures delayed 15+ min, by weekday and scheduled hour",
                      yaxis=dict(autorange="reversed"), height=380, margin=dict(t=50, b=10))
    st.plotly_chart(fig, width="stretch")
    st.caption(f"Blank cells have fewer than {MIN_CELL} operated flights in the current filter.")

# ---------------- tab 2: routes + reasons ----------------
with tab2:
    left, right = st.columns([3, 2])
    with left:
        st.subheader("Destinations ranked by departure delay rate")
        min_n = st.slider("Minimum operated flights per route", 0, 300, 50, step=10)
        routes = m.route_table(view, min_n)
        routes["dest"] = f"{meta['airport']} -> " + routes["dest"]
        st.dataframe(
            routes, hide_index=True, height=420, width="stretch",
            column_config={
                "dest": "Route",
                "delay_rate": st.column_config.ProgressColumn("Delayed 15+ (of operated)", format="percent",
                                                               min_value=0, max_value=1),
            },
        )
        st.caption(f"{len(routes)} routes shown.")
    with right:
        st.subheader("Recorded delay reasons")
        reasons, n_reason = m.reason_summary(view)
        st.metric("Flights with reason data", f"{n_reason:,}",
                  f"{n_reason / max(k['operated'], 1):.1%} of operated departures", delta_color="off")
        bar = px.bar(reasons.sort_values("minutes"), x="minutes", y="reason", orientation="h",
                     text=reasons.sort_values("minutes")["share_of_minutes"].map("{:.0%}".format),
                     labels={"minutes": "Recorded delay minutes", "reason": ""})
        bar.update_layout(height=320, margin=dict(t=10, b=10))
        st.plotly_chart(bar, width="stretch")
        st.caption("BTS records causes only for flights that *arrived* 15+ min late, so these minutes describe "
                   "arrival delay attribution. Used for historical analysis only - never as an input to the "
                   "risk score, because they are not known before departure.")

# ---------------- tab 3: risk watchlist ----------------
with tab3:
    if risk is None:
        st.info("Run `python risk.py` to build the historical risk score.")
        st.stop()
    st.subheader(f"Historical risk score - historical holdout: {risk['holdout_month']}")
    st.caption(f"Rates learned from {' & '.join(risk['train_months'])} by destination x scheduled-departure "
               f"time band (groups under {risk['min_group_size']} flights fall back to the time-band rate). "
               f"Each holdout flight is scored from its schedule only; the top {risk['alerts_per_day']} per day "
               "are alerts. This is a back-test on past data, not a live forecast.")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Holdout delay rate (all operated)", f"{risk['holdout_delay_rate']:.1%}")
    c2.metric("Delay rate among alerts", f"{risk['alerts_delay_rate']:.1%}",
              f"{risk['lift_vs_holdout']:.2f}x the holdout rate", delta_color="off")
    c3.metric("True delays caught by alerts", f"{risk['alerts_true_delays']:,}",
              f"of {risk['alerts_operated']:,} operated alerts", delta_color="off")
    c4.metric("Share of all holdout delays caught", f"{risk['share_of_all_holdout_delays_caught']:.1%}",
              f"{risk['holdout_delayed']:,} delays in month", delta_color="off")

    days = sorted(scores["flight_date"].dt.date.unique())
    day = st.select_slider("Review day", options=days, value=days[0])
    watch = scores[(scores["flight_date"].dt.date == day) & scores["is_alert"]].copy()
    watch["sched_dep"] = watch["crs_dep_time"].map(lambda t: f"{int(t) // 100 % 24:02d}:{int(t) % 100:02d}")
    watch["outcome"] = watch.apply(
        lambda r: "Cancelled" if r["cancelled"] else ("No outcome" if r["missing_outcome"] else
                  (f"Delayed {r['dep_delay']:.0f} min" if r["delayed_15"] else "On time (<15)")), axis=1)
    st.dataframe(
        watch.sort_values("risk_score", ascending=False)[
            ["sched_dep", "carrier", "flight_number", "dest", "band", "risk_score", "score_level", "outcome"]],
        hide_index=True, width="stretch",
        column_config={"risk_score": st.column_config.NumberColumn("Historical risk", format="percent"),
                       "outcome": "Actual outcome (revealed after the fact)"},
    )
