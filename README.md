# Flight Delay Operations Dashboard

**Live site:** https://ord-delay-ops.vercel.app / **Code:** https://github.com/Adityas221b/flight-delay-ops-dashboard

**Business question:** At Chicago O'Hare (ORD), when are departing flights most likely to run late, and which flights should an operations team review first?

A small, fully local project: a repeatable data pipeline on official U.S. BTS data, one Streamlit dashboard, and a simple historical risk score checked on a holdout month.

| Item | Value |
|---|---|
| Data | BTS *Reporting Carrier On-Time Performance (1987–present)*, monthly pre-zipped files |
| Airport / months | ORD departures, **July, August, September 2026** (98,498 scheduled flights) |
| Delay definition | Operated departure that left **15+ minutes** after its scheduled (CRS) departure time |
| Stack | Python 3.12, pandas, Streamlit, Plotly, pytest |

## Setup and run

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

python pipeline.py --latest   # finds the newest 3 months BTS has published, downloads to data/raw/
python risk.py                # trains on the first 2 months, scores the third (holdout)
python -m pytest -q           # 8 tests on a small synthetic fixture
python export_web.py          # writes web/data/*.json for the public web app
python -m http.server 8600 --directory web    # web app at http://localhost:8600
streamlit run app.py          # optional: the original Streamlit dashboard at http://localhost:8501
```

Fixed months instead of the latest: `python pipeline.py --months 2026-04 2026-05 2026-06`.

### Web app and deployment

`web/` is a static site with no framework and no build step: `index.html`, `styles.css`, `app.js`, and the two JSON files from `export_web.py`. The browser filters and aggregates all ~98k flights itself, using the same definitions as the Python code. The charts are hand-written SVG. Sections:

1. **Overview:** KPIs with the delay-rate denominator spelled out, plus a daily delay-rate trend.
2. **Patterns:** a 24-hour delay clock, and a clickable weekday x hour matrix that gives each slot's rate, 95% interval and worst routes. Also the recorded delay reasons.
3. **Routes:** a sortable, searchable table with a minimum-flights slider. Clicking a route loads it into the estimator.
4. **Estimator:** pick a destination and departure time to get **P(departs 15+ min late)** with a 95% Wilson interval. It shows the sample size and fallback level, and checks the estimate against what actually happened in the holdout month.
5. **Model:** ROC AUC, a ROC curve, calibration by decile, Brier skill, and a decision-threshold slider. The slider updates the confusion matrix, accuracy, precision, recall and F1.
6. **Watchlist:** the 10 highest-risk flights for each holdout day, next to the actual outcome.

Deploy (Vercel CLI):
```powershell
vercel login
vercel deploy web --prod
```
**"Live" data:** BTS has no real-time feed and publishes each month about 2–3 months late. `pipeline.py --latest` always picks the newest published month. `.github/workflows/refresh.yml` reruns the pipeline weekly and redeploys. It becomes active once the project is pushed to GitHub with `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` set as repository secrets.

**If the download is blocked**, open the [BTS table page](https://www.transtats.bts.gov/TableInfo.asp?QO_fu146_anzr=b0-gvzr&gnoyr_VQ=FGJ), click **Download**, choose the year and month, and tick FlightDate, Reporting_Airline, Flight_Number, Tail_Number, Origin, Dest, CRSDepTime, DepTime, DepDelay, Cancelled, CancellationCode, Diverted and the five `*Delay` cause fields. Save each ZIP into `data/raw/` and run:
`python pipeline.py --files data/raw/a.zip data/raw/b.zip data/raw/c.zip`.
The pipeline accepts both BTS naming styles (`CRSDepTime` and `CRS_DEP_TIME`).

Raw and processed data are git-ignored. Each run writes `data/processed/pipeline_metadata.json`, which records the months, source URL, file names and per-month counts.

> Windows note: keep the project in a short path, such as `C:\dev\flight-delay-ops`. Windows' 260-character path limit can break `pip install` inside deeply nested folders.

## How it works

| File | Role |
|---|---|
| `pipeline.py` | **Engineering.** Reads each BTS ZIP or CSV in chunks, keeps only `Origin == ORD`, maps column aliases, parses `hhmm` times (`5` → 00:05, `2400` → midnight), and builds the flags below. |
| `metrics.py` | Shared calculations: KPIs, heatmap, route table and delay reasons. The dashboard and the tests call the same functions. |
| `risk.py` | **Analytics.** Historical risk score and the holdout evaluation. |
| `app.py` | **Digital.** The Streamlit dashboard with three tabs. |
| `tests/` | Unit tests on a hand-made **synthetic** fixture. No real data is used in the tests. |

**Flags used everywhere:**
- `cancelled`: BTS `Cancelled = 1`. Cancelled flights are shown as their own count and are never counted as delayed.
- `missing_outcome`: not cancelled, but no departure delay was recorded. These flights are excluded from the delay-rate denominator, and the dashboard reports how many were excluded. Jul–Sep 2026 had 0 such flights.
- `operated`: not cancelled and a departure delay is known. This is the delay-rate denominator. Diverted flights count as operated because they did depart.
- `delayed_15`: operated and `DepDelay >= 15`.

**Risk score (simple and explainable):**
1. Train on July and August. For each *destination × scheduled-departure time band*, compute the share of operated flights delayed 15+ min. There are 7 bands: 00–06, 06–09, 09–12, 12–15, 15–18, 18–21 and 21–24.
2. **Minimum group size = 30 operated flights.** A smaller group falls back to the broader rate for its time band. If the band is also too small, it falls back to the overall training rate. In September, 30,180 flights were scored at the destination+band level and 2,121 used the band fallback.
3. Score every September flight using **only schedule information**: destination and scheduled time.
4. Each day, flag the **top 10** flights as alerts. Many flights share the same score, so ties are broken randomly with a fixed seed. Across 20 different seeds, the alert delay rate stayed between 48.8% and 50.8%.

## Results (real data, ORD, Jul–Sep 2026)

| Metric | Value |
|---|---|
| Scheduled / cancelled / operated | 98,498 / 2,554 (2.6%) / 95,944 |
| Delayed 15+ min (of operated) | **29.9%** (28,678) |
| Excluded for missing outcome | 0 |
| Delay rate by time band | 06–09: **14.2%** → 12–15: 29.7% → 15–18: 38.8% → 18–21: **43.0%** |
| Worst weekday | Sunday 38.0% (best: Wednesday 23.8%) |
| Hottest heatmap cells (≥50 flights) | Sunday 18:00–20:59 (52–55%) and Thursday 20:00 (52%) |
| Busy routes with the highest rates (≥300 flights) | SAT 42%, BOS 41%, PHL 38%, PHX 37%, EWR 36% |
| Recorded delay minutes | Late-arriving aircraft 47%, Carrier 24%, NAS 21%, **Weather 7.5%**, Security <0.1% (30,438 flights have reason data) |

**Historical holdout (September 2026), historical risk score:**

| | Value |
|---|---|
| Overall holdout delay rate | **29.5%** (9,417 of 31,892 operated) |
| Alerts | 300 (10/day × 30 days): 297 operated, 3 cancelled |
| Delay rate among alerts | **49.5%**, which is **1.68×** the holdout rate |
| True delays caught by alerts | **147** |
| Share of all September delays caught | 1.6%. This is expected: 10 alerts a day is a short review list, not full coverage. |
| ROC AUC (all 31,892 operated holdout flights) | **0.637** (0.5 = coin flip). The reference project's XGBoost reported 0.643. |
| Brier score | 0.1996, against 0.2081 for always predicting the training average: a **4.1% skill** gain |
| Calibration | Close in the middle deciles. The top decile is over-confident: predicted 54.7%, observed 47.9%. |
| Accuracy at threshold 0.40 | 66.6%, with precision 42.2% and recall 35.2%. Always answering "on time" would score 70.5% accuracy, which is why the site leads with AUC, calibration and alert precision rather than accuracy. |

**Verification:**
- The September counts were recomputed directly from the raw ZIP and matched: 32,301 scheduled, 409 cancelled and 31,892 operated.
- BTS's own `DepDel15` flag marks 9,421 flights. 9,417 of them are not cancelled, which matches our count exactly. The other 4 were cancelled after pushing back late, and they are correctly counted as cancellations.
- The dashboard filters were checked in the browser. UA with Aug 1–15 showed 4,698 scheduled, 67 cancelled and 37.5% delayed, which matches an independent pandas calculation.
- The training months (Jul and Aug) and the holdout month (Sep) do not overlap. Every holdout day has exactly 10 alerts.

## Three-minute interview walkthrough

1. **Engineering pipeline (≈1 min).** "I pull three months of official BTS on-time files, about 600k U.S. flights per month, and stream them in chunks so memory stays small. I keep only ORD departures. The tricky parts were BTS's two column-naming styles, `hhmm` integer times where 2400 means midnight, and the definitions. Cancelled flights are reported separately. Flights with no departure outcome are excluded from the denominator, and the dashboard shows how many were excluded. I reconciled my numbers against BTS's own `DepDel15` flag, and the 4-flight gap turned out to be cancelled flights."
2. **Analytics evaluation (≈1 min).** "The risk score is just a historical delay rate for each destination and departure-time band, learned from July and August. Any group with fewer than 30 flights falls back to the time-band rate. I scored September using schedule information only, which is what an ops team knows the night before. The top 10 flights each day were delayed 49.5% of the time, against 29.5% for all flights. That is about 1.7× better than picking at random: 147 real delays out of 297 operated alerts. I deliberately left delay-cause fields out of the score, because they are only recorded after a flight arrives late."
3. **Digital web app (≈1 min).** On the live site: hover the delay clock, click a Sunday-evening cell in the matrix, open the estimator for a route at 19:00 and read out its probability and interval, then drag the threshold slider to show why accuracy alone misleads. Finish on a watchlist day. The Streamlit version below remains as a local alternative.
   **Streamlit (local).** Demo the tabs in order. *Tab 1*: KPIs with the denominator spelled out, and the weekday × hour heatmap, where late afternoon and evening turn red, especially on Sunday. *Tab 2*: the route table, with a minimum-flights slider so tiny routes don't top the list, and the recorded reasons, where late-arriving aircraft is the biggest cause and weather is about 7.5%. *Tab 3*: pick a September day and show the 10 alerts next to what actually happened. Then use the carrier and date filters to show that everything recalculates.

## Limitations

- Only three summer months at one airport. Seasonality, such as winter snow, is not captured, and the September holdout is a single back-test.
- The score is static per destination and time slot, so the same evening flights tend to appear on the watchlist every day. It ranks *slots*, not day-specific conditions.
- Delay-reason fields exist only for flights that **arrived** 15+ min late. They describe arrival-delay attribution, are used for historical context only, and are never used in the score.
- BTS Reporting Carrier data covers U.S. carriers' domestic flights. Foreign airlines at ORD are not included.
- BTS data for the most recent months can be revised after release.
- The risk number is a historical rate, not a calibrated probability or a live forecast.

## Possible extensions (deliberately not in v1)

- Weather observations, such as NOAA METAR at ORD, joined by hour.
- Aircraft rotations: whether the inbound aircraft (same tail number) is late. The reference project found this to be the strongest delay driver.
- A gradient-boosted model, such as XGBoost, compared against this simple baseline.
- More months, and a rolling train/holdout window.

## Credits

- Data: U.S. DOT Bureau of Transportation Statistics, [Reporting Carrier On-Time Performance](https://www.transtats.bts.gov/TableInfo.asp?QO_fu146_anzr=b0-gvzr&gnoyr_VQ=FGJ). This is public U.S. government data.
- Reference project: [baichuan23/airline-delay-reliability-analysis](https://github.com/baichuan23/airline-delay-reliability-analysis). It was reviewed for ideas: time-band delay patterns, delay-cause breakdown and a high-risk watchlist. The repository has **no LICENSE file**, so **no code was copied**, and this project is an original implementation. The reference uses Jupyter notebooks with hard-coded local Windows paths, a MySQL database and a Power BI `.pbix` file. Its raw data is not included, so it cannot be re-run as-is.

## Operational recommendation

Focus pre-departure review and turnaround resources on the **15:00–21:00 departure bank**, especially **Sunday and Thursday evenings**. ORD departures in that window were delayed 39–43% of the time, compared with 14% before 09:00. Late-arriving aircraft caused 47% of recorded delay minutes, so the practical lever is protecting the inbound turns that feed the evening bank. The 10-a-day historical watchlist, which ran at 49.5% delayed against a 29.5% baseline in the September holdout, is a reasonable starting list for that review.
