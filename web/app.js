/* ORD Departure Delay Ops - static front end.
   All numbers are computed in the browser from web/data/*.json, which export_web.py writes
   from the same pipeline as the Python code. Charts are plain SVG; no framework, no build step. */
"use strict";

const $ = (s) => document.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");
const int = (n) => Number(n).toLocaleString("en-US");
const hhmm = (t) => String(Math.floor(t / 100) % 24).padStart(2, "0") + ":" + String(t % 100).padStart(2, "0");
const bandName = (b) => b.slice(2);                         // "6 Evening 18-21" -> "Evening 18-21"
const MIN_CELL = 10;                                         // heatmap cells below this are shown empty

function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

/* Wilson 95% interval for k successes out of n. */
function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

/* Sequential scale: deep indigo -> bright indigo -> pale -> amber for the worst cells. */
const STOPS = [[0, [14, 20, 80]], [0.45, [63, 81, 255]], [0.75, [183, 191, 255]], [1, [255, 181, 71]]];
function heatColor(rate, max = 0.6) {
  const t = Math.max(0, Math.min(1, rate / max));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i], [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * f)).join(",")})`;
    }
  }
  return "rgb(255,181,71)";
}

/* tooltip */
const tip = $("#tip");
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.style.opacity = 1;
  const x = Math.min(evt.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px";
  tip.style.top = evt.clientY + 14 + "px";
}
const hideTip = () => (tip.style.opacity = 0);

/* ------------------------------------------------------------------ data */
let F, M, C, N, META;          // flights json, model json, typed columns, row count, metadata
const state = { d0: 0, d1: 0, carriers: new Set(), heatCell: null, sortKey: "rate", sortDir: -1, day: null };

async function boot() {
  const [f, m] = await Promise.all([fetch("data/flights.json").then((r) => r.json()),
                                    fetch("data/model.json").then((r) => r.json())]);
  F = f; M = m; META = f.meta;
  const c = f.cols;
  N = c.d.length;
  C = {
    d: Int16Array.from(c.d), c: Uint8Array.from(c.c), r: Int16Array.from(c.r), w: Uint8Array.from(c.w),
    h: Uint8Array.from(c.h), t: Int16Array.from(c.t), s: Uint8Array.from(c.s), dd: c.dd, fn: c.fn,
    hr: Uint8Array.from(c.hr), reasons: [c.rc, c.rw, c.rn, c.rs, c.rl],
  };
  state.d1 = F.dict.dates.length - 1;
  initHeader();
  initControls();
  initEstimator();
  initModel();
  initWatchlist();
  update();
  $("#loader").classList.add("done");
}

/* One pass over all flights that pass the filters; everything in sections 01-03 comes from here. */
function aggregate() {
  const nd = F.dict.dates.length, nr = F.dict.dests.length;
  const A = {
    sched: 0, cx: 0, miss: 0, op: 0, del: 0,
    dayOp: new Uint32Array(nd), dayDel: new Uint32Array(nd),
    heatOp: new Uint32Array(7 * 24), heatDel: new Uint32Array(7 * 24),
    hourOp: new Uint32Array(24), hourDel: new Uint32Array(24),
    rSched: new Uint32Array(nr), rCx: new Uint32Array(nr), rOp: new Uint32Array(nr), rDel: new Uint32Array(nr),
    reasonMin: [0, 0, 0, 0, 0], reasonCite: [0, 0, 0, 0, 0], withReason: 0,
  };
  const cs = state.carriers.size ? state.carriers : null;
  for (let i = 0; i < N; i++) {
    const d = C.d[i];
    if (d < state.d0 || d > state.d1 || (cs && !cs.has(C.c[i]))) continue;
    const s = C.s[i], r = C.r[i];
    A.sched++; A.rSched[r]++;
    if (s === 2) { A.cx++; A.rCx[r]++; continue; }
    if (s === 3) { A.miss++; continue; }
    const late = s === 1 ? 1 : 0, cell = C.w[i] * 24 + C.h[i];
    A.op++; A.del += late;
    A.dayOp[d]++; A.dayDel[d] += late;
    A.heatOp[cell]++; A.heatDel[cell] += late;
    A.hourOp[C.h[i]]++; A.hourDel[C.h[i]] += late;
    A.rOp[r]++; A.rDel[r] += late;
    if (C.hr[i]) {
      A.withReason++;
      for (let k = 0; k < 5; k++) {
        const v = C.reasons[k][i] || 0;
        A.reasonMin[k] += v;
        if (v > 0) A.reasonCite[k]++;
      }
    }
  }
  A.rate = A.op ? A.del / A.op : NaN;
  return A;
}

function update() {
  const A = aggregate();
  renderKpis(A);
  renderDaily(A);
  renderClock(A);
  renderHeatmap(A);
  renderCellDetail();
  renderReasons(A);
  renderRoutes(A);
}

/* ------------------------------------------------------------------ header + controls */
function initHeader() {
  const months = META.months.join(" / ");
  $("#statusLine").textContent = `BTS ON-TIME / ${months}`;
  $("#freshness").textContent = `Dataset current to ${META.data_through} / latest published BTS month`;
  let op = 0, del = 0;
  for (let i = 0; i < N; i++) if (C.s[i] < 2) { op++; del += C.s[i]; }
  $("#heroStats").innerHTML =
    `<div><b>${int(N)}</b><span>SCHEDULED DEPARTURES</span></div>` +
    `<div><b>${pct(del / op)}</b><span>DELAYED 15+ MIN</span></div>` +
    `<div><b>${F.dict.dests.length}</b><span>DESTINATIONS</span></div>`;
  $("#sourceLine").innerHTML = `Source: U.S. DOT Bureau of Transportation Statistics, <a href="${META.source.split(", ").pop()}" target="_blank" rel="noopener">Reporting Carrier On-Time Performance</a>. Files: ${META.source_files.join(", ")}.`;
}

function initControls() {
  const dates = F.dict.dates;
  for (const id of ["#dateFrom", "#dateTo"]) { $(id).min = dates[0]; $(id).max = dates[dates.length - 1]; }
  const syncDates = () => { $("#dateFrom").value = dates[state.d0]; $("#dateTo").value = dates[state.d1]; };
  syncDates();
  const pick = (v, fallback) => { const i = dates.indexOf(v); return i < 0 ? fallback : i; };
  $("#dateFrom").addEventListener("change", (e) => { state.d0 = Math.min(pick(e.target.value, 0), state.d1); syncDates(); update(); });
  $("#dateTo").addEventListener("change", (e) => { state.d1 = Math.max(pick(e.target.value, dates.length - 1), state.d0); syncDates(); update(); });

  // carrier chips ordered by volume
  const vol = new Uint32Array(F.dict.carriers.length);
  for (let i = 0; i < N; i++) vol[C.c[i]]++;
  const order = [...vol.keys()].sort((a, b) => vol[b] - vol[a]);
  const box = $("#carrierChips");
  for (const ci of order) {
    const code = F.dict.carriers[ci];
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = code;
    b.title = `${META.carrier_names[code] || code} / ${int(vol[ci])} departures`;
    b.addEventListener("click", () => {
      state.carriers.has(ci) ? state.carriers.delete(ci) : state.carriers.add(ci);
      b.classList.toggle("on");
      update();
    });
    box.appendChild(b);
  }
  $("#resetBtn").addEventListener("click", () => {
    state.d0 = 0; state.d1 = dates.length - 1; state.carriers.clear(); state.heatCell = null;
    box.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    syncDates(); update();
  });
}

/* ------------------------------------------------------------------ 01 overview */
function renderKpis(A) {
  const k = (label, val, sub, cls = "") => `<div class="kpi ${cls}"><div class="k-label">${label}</div><div class="k-val">${val}</div><div class="k-sub">${sub}</div></div>`;
  $("#kpis").innerHTML =
    k("SCHEDULED", int(A.sched), `${state.d1 - state.d0 + 1} days in range`) +
    k("CANCELLED", int(A.cx), `${pct(A.cx / A.sched)} of scheduled`) +
    k("OPERATED", int(A.op), "delay-rate denominator", "ind") +
    k("DELAYED 15+ MIN", pct(A.rate), `${int(A.del)} of ${int(A.op)} operated`, "hi");
  $("#denomNote").textContent = `Excluded from the rate: ${int(A.cx)} cancelled, ${int(A.miss)} with no recorded departure outcome.`;
}

function renderDaily(A) {
  const svg = clear($("#daily")), W = 1100, H = 220, pl = 44, pr = 10, pt = 12, pb = 26;
  const idx = [];
  for (let d = state.d0; d <= state.d1; d++) if (A.dayOp[d]) idx.push(d);
  if (!idx.length) return;
  const rates = idx.map((d) => A.dayDel[d] / A.dayOp[d]);
  const ymax = Math.max(0.6, Math.ceil(Math.max(...rates) * 10) / 10);
  const x = (j) => pl + (idx.length === 1 ? (W - pl - pr) / 2 : (j / (idx.length - 1)) * (W - pl - pr));
  const y = (v) => pt + (1 - v / ymax) * (H - pt - pb);
  for (let v = 0; v <= ymax + 1e-9; v += 0.2) {
    svgEl("line", { x1: pl, x2: W - pr, y1: y(v), y2: y(v), class: "gridline" }, svg);
    svgEl("text", { x: pl - 8, y: y(v) + 3, "text-anchor": "end" }, svg).textContent = Math.round(v * 100) + "%";
  }
  const defs = svgEl("defs", {}, svg);
  const g = svgEl("linearGradient", { id: "dailyFill", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  svgEl("stop", { offset: "0%", "stop-color": "#3f51ff", "stop-opacity": 0.45 }, g);
  svgEl("stop", { offset: "100%", "stop-color": "#3f51ff", "stop-opacity": 0 }, g);
  const pts = rates.map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`);
  svgEl("path", { d: `M${x(0)},${y(0)} L${pts.join(" L")} L${x(idx.length - 1)},${y(0)} Z`, fill: "url(#dailyFill)" }, svg);
  svgEl("path", { d: "M" + pts.join(" L"), fill: "none", stroke: "#8f9bff", "stroke-width": 1.6 }, svg);
  svgEl("line", { x1: pl, x2: W - pr, y1: y(A.rate), y2: y(A.rate), stroke: "#ffb547", "stroke-dasharray": "5 5", "stroke-width": 1 }, svg);
  svgEl("text", { x: W - pr, y: y(A.rate) - 6, "text-anchor": "end", fill: "#ffb547" }, svg).textContent = `PERIOD AVG ${pct(A.rate)}`;
  const step = Math.max(1, Math.ceil(idx.length / 10));
  idx.forEach((d, j) => { if (j % step === 0) svgEl("text", { x: x(j), y: H - 6, "text-anchor": "middle" }, svg).textContent = F.dict.dates[d].slice(5); });
  const cursor = svgEl("line", { y1: pt, y2: H - pb, stroke: "#8f9bff", "stroke-width": 1, opacity: 0 }, svg);
  const dot = svgEl("circle", { r: 4, fill: "#04061a", stroke: "#e8ebff", "stroke-width": 1.5, opacity: 0 }, svg);
  const hit = svgEl("rect", { x: pl, y: pt, width: W - pl - pr, height: H - pt - pb, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const j = Math.max(0, Math.min(idx.length - 1, Math.round(((px - pl) / (W - pl - pr)) * (idx.length - 1))));
    const d = idx[j];
    cursor.setAttribute("x1", x(j)); cursor.setAttribute("x2", x(j)); cursor.setAttribute("opacity", 0.6);
    dot.setAttribute("cx", x(j)); dot.setAttribute("cy", y(rates[j])); dot.setAttribute("opacity", 1);
    const wd = META.weekdays[new Date(F.dict.dates[d] + "T12:00:00Z").getUTCDay() === 0 ? 6 : new Date(F.dict.dates[d] + "T12:00:00Z").getUTCDay() - 1];
    showTip(e, `<b>${F.dict.dates[d]}</b> ${wd}<br>${pct(rates[j])} delayed<br>${int(A.dayDel[d])} of ${int(A.dayOp[d])} operated`);
  });
  hit.addEventListener("mouseleave", () => { hideTip(); cursor.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); });
  let worst = 0; rates.forEach((v, j) => { if (v > rates[worst]) worst = j; });
  $("#dailyNote").textContent = `worst day ${F.dict.dates[idx[worst]]} at ${pct(rates[worst])}`;
}

/* Hero graphic: 24 radial bars, one per scheduled departure hour. */
function renderClock(A) {
  const svg = clear($("#clock")), cx = 200, cy = 200, r0 = 78, r1 = 182, vmax = 0.6;
  for (const v of [0.2, 0.4, 0.6]) {
    const rr = r0 + (v / vmax) * (r1 - r0);
    svgEl("circle", { cx, cy, r: rr, fill: "none", stroke: "#1b2462", "stroke-dasharray": "2 4" }, svg);
    svgEl("text", { x: cx + 4, y: cy - rr + 11, fill: "#545d97" }, svg).textContent = v * 100 + "%";
  }
  svgEl("circle", { cx, cy, r: r0 - 4, fill: "#070b2b", stroke: "#2a3584" }, svg);
  for (let h = 0; h < 24; h++) {
    const a0 = ((h / 24) * 360 - 90 + 1.4) * Math.PI / 180, a1 = (((h + 1) / 24) * 360 - 90 - 1.4) * Math.PI / 180;
    const op = A.hourOp[h], rate = op ? A.hourDel[h] / op : 0;
    const rr = r0 + (Math.min(rate, vmax) / vmax) * (r1 - r0);
    const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    const d = `M${p(r0, a0)} L${p(rr, a0)} A${rr},${rr} 0 0 1 ${p(rr, a1)} L${p(r0, a1)} A${r0},${r0} 0 0 0 ${p(r0, a0)} Z`;
    const seg = svgEl("path", { d, fill: op >= MIN_CELL ? heatColor(rate) : "#111845", opacity: 0.95 }, svg);
    seg.addEventListener("mousemove", (e) => showTip(e, `<b>${String(h).padStart(2, "0")}:00-${String(h).padStart(2, "0")}:59</b><br>${op >= MIN_CELL ? pct(rate) + " delayed" : "too few flights"}<br>${int(op)} operated`));
    seg.addEventListener("mouseleave", hideTip);
    if (h % 3 === 0) {
      const am = ((h / 24) * 360 - 90) * Math.PI / 180;
      svgEl("text", { x: cx + (r1 + 12) * Math.cos(am), y: cy + (r1 + 12) * Math.sin(am) + 3, "text-anchor": "middle", fill: "#8790c4" }, svg).textContent = String(h).padStart(2, "0");
    }
  }
  svgEl("text", { x: cx, y: cy - 4, "text-anchor": "middle", fill: "#e8ebff", "font-size": 30, "font-weight": 500 }, svg).textContent = pct(A.rate);
  svgEl("text", { x: cx, y: cy + 18, "text-anchor": "middle", fill: "#8790c4", "font-size": 9.5, "letter-spacing": "0.12em" }, svg).textContent = "DELAYED 15+ MIN";
  svgEl("text", { x: cx, y: cy + 32, "text-anchor": "middle", fill: "#545d97", "font-size": 9 }, svg).textContent = `${int(A.op)} OPERATED`;
}

/* ------------------------------------------------------------------ 02 patterns */
function renderHeatmap(A) {
  const svg = clear($("#heatmap")), pl = 84, pt = 8, cw = (760 - pl - 6) / 24, ch = 34;
  META.weekdays.forEach((wd, w) => {
    svgEl("text", { x: pl - 10, y: pt + w * ch + ch / 2 + 3, "text-anchor": "end" }, svg).textContent = wd.slice(0, 3).toUpperCase();
    for (let h = 0; h < 24; h++) {
      const cell = w * 24 + h, op = A.heatOp[cell], rate = op ? A.heatDel[cell] / op : NaN;
      const ok = op >= MIN_CELL;
      const selected = state.heatCell && state.heatCell[0] === w && state.heatCell[1] === h;
      const rect = svgEl("rect", {
        x: pl + h * cw + 1, y: pt + w * ch + 1, width: cw - 2, height: ch - 2, rx: 2,
        fill: ok ? heatColor(rate) : "transparent", stroke: selected ? "#ffffff" : ok ? "none" : "#1b2462",
        "stroke-width": selected ? 2 : 1, style: "cursor:pointer",
      }, svg);
      rect.addEventListener("mousemove", (e) => showTip(e, `<b>${wd} ${String(h).padStart(2, "0")}:00</b><br>${ok ? pct(rate) + " delayed" : "fewer than " + MIN_CELL + " flights"}<br>${int(op)} operated`));
      rect.addEventListener("mouseleave", hideTip);
      rect.addEventListener("click", () => { state.heatCell = [w, h]; renderHeatmap(A); renderCellDetail(); });
    }
  });
  for (let h = 0; h < 24; h += 2) svgEl("text", { x: pl + h * cw + cw / 2, y: pt + 7 * ch + 16, "text-anchor": "middle" }, svg).textContent = String(h).padStart(2, "0");
  $("#heatLegend").innerHTML = `0% <i style="background:linear-gradient(90deg,${[0, 0.15, 0.3, 0.45, 0.6].map((v) => heatColor(v)).join(",")})"></i> 60%+`;
}

function renderCellDetail() {
  const box = $("#cellDetail");
  if (!state.heatCell) {
    box.innerHTML = `<div class="panel-head mono"><span>SLOT DETAIL</span></div><p class="muted">Select a cell in the matrix to see its delay rate, confidence interval and worst routes.</p>`;
    return;
  }
  const [w, h] = state.heatCell, cs = state.carriers.size ? state.carriers : null;
  let op = 0, del = 0, sumLate = 0;
  const byDest = new Map();
  for (let i = 0; i < N; i++) {
    if (C.w[i] !== w || C.h[i] !== h || C.s[i] > 1) continue;
    if (C.d[i] < state.d0 || C.d[i] > state.d1 || (cs && !cs.has(C.c[i]))) continue;
    op++;
    const late = C.s[i] === 1;
    if (late) { del++; sumLate += C.dd[i]; }
    const v = byDest.get(C.r[i]) || [0, 0];
    v[0]++; if (late) v[1]++;
    byDest.set(C.r[i], v);
  }
  const [lo, hi] = wilson(del, op);
  const top = [...byDest.entries()].filter(([, v]) => v[0] >= 5).sort((a, b) => b[1][1] / b[1][0] - a[1][1] / a[1][0]).slice(0, 5);
  box.innerHTML = `<div class="panel-head mono"><span>SLOT DETAIL</span><span class="accent">${META.weekdays[w].toUpperCase()} ${String(h).padStart(2, "0")}:00</span></div>
    <h3>${op ? pct(del / op) : "n/a"}</h3><div class="mono muted" style="font-size:11.5px">of operated departures left 15+ min late</div>
    <div class="kv"><span>Operated</span><span>${int(op)}</span><span>Delayed</span><span>${int(del)}</span>
    <span>95% interval</span><span>${op ? pct(lo) + " to " + pct(hi) : "n/a"}</span>
    <span>Avg delay when late</span><span>${del ? Math.round(sumLate / del) + " min" : "n/a"}</span></div>
    <div class="mono muted" style="font-size:10.5px;letter-spacing:.1em">HIGHEST-RATE ROUTES IN SLOT (5+ FLIGHTS)</div>
    <ol>${top.map(([r, v]) => `<li>${META.airport} &rarr; ${F.dict.dests[r]} <span class="muted">${pct(v[1] / v[0], 0)} of ${v[0]}</span></li>`).join("") || "<li class='muted'>not enough flights</li>"}</ol>`;
}

function renderReasons(A) {
  const total = A.reasonMin.reduce((a, b) => a + b, 0) || 1;
  const rows = META.reasons.map((name, k) => ({ name, min: A.reasonMin[k], cite: A.reasonCite[k] })).sort((a, b) => b.min - a.min);
  $("#reasons").innerHTML = rows.map((r) => `<div class="bar-row ${r.name === "Weather" ? "weather" : ""}"><span>${r.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${((r.min / total) * 100).toFixed(1)}%"></div></div>
      <span class="v">${pct(r.min / total)} / ${int(Math.round(r.min / 1000))}k min</span></div>`).join("");
  $("#reasonNote").textContent = `${int(A.withReason)} flights with reason data (${pct(A.withReason / (A.op || 1))} of operated)`;
}

/* ------------------------------------------------------------------ 03 routes */
let lastAgg = null;
function renderRoutes(A) {
  lastAgg = A || lastAgg;
  A = lastAgg;
  if (!A) return;                              // data not loaded yet
  const q = $("#routeSearch").value.trim().toUpperCase(), minN = +$("#minFlights").value;
  const rows = [];
  F.dict.dests.forEach((dest, r) => {
    if (!A.rSched[r] || A.rOp[r] < minN || (q && !dest.includes(q))) return;
    rows.push({ dest, r, scheduled: A.rSched[r], cancelled: A.rCx[r], operated: A.rOp[r], delayed: A.rDel[r], rate: A.rOp[r] ? A.rDel[r] / A.rOp[r] : -1 });
  });
  const k = state.sortKey, dir = state.sortDir;
  rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir);
  const maxRate = Math.max(0.01, ...rows.map((r) => r.rate));
  $("#routeTable tbody").innerHTML = rows.map((r) => `<tr class="click" data-dest="${r.dest}"><td>${META.airport} &rarr; ${r.dest}</td>
      <td class="num">${int(r.scheduled)}</td><td class="num">${int(r.cancelled)}</td><td class="num">${int(r.operated)}</td>
      <td class="num">${int(r.delayed)}</td><td class="num"><div class="rate-cell"><i style="width:${Math.max(0, (r.rate / maxRate) * 70)}px;background:${heatColor(r.rate)}"></i>${pct(r.rate)}</div></td></tr>`).join("");
  $("#routeCount").textContent = `${rows.length} routes`;
  document.querySelectorAll("#routeTable th").forEach((th) => th.classList.toggle("sorted", th.dataset.k === k));
}
document.querySelectorAll("#routeTable th").forEach((th) => th.addEventListener("click", () => {
  state.sortDir = state.sortKey === th.dataset.k ? -state.sortDir : th.dataset.k === "dest" ? 1 : -1;
  state.sortKey = th.dataset.k;
  renderRoutes();
}));
$("#routeSearch").addEventListener("input", () => renderRoutes());
$("#minFlights").addEventListener("input", (e) => { $("#minFlightsOut").textContent = e.target.value; renderRoutes(); });
$("#routeTable tbody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  $("#estDest").value = tr.dataset.dest;
  renderEstimator();
  document.getElementById("estimator").scrollIntoView();
});

/* ------------------------------------------------------------------ 04 estimator */
let GROUP, BAND, HOLD_BY_SLOT;
function initEstimator() {
  GROUP = new Map(M.group_rates.map(([dest, band, n, p, lo, hi]) => [dest + "|" + band, { n, p, lo, hi }]));
  BAND = new Map(M.band_rates.map(([band, n, p, lo, hi]) => [band, { n, p, lo, hi }]));
  // observed holdout outcome per dest|band, used to show how the estimate held up
  HOLD_BY_SLOT = new Map();
  M.holdout.row.forEach((row) => {
    if (C.s[row] > 1) return;
    const key = F.dict.dests[C.r[row]] + "|" + bandOf(C.h[row]);
    const v = HOLD_BY_SLOT.get(key) || [0, 0];
    v[0]++; v[1] += C.s[row];
    HOLD_BY_SLOT.set(key, v);
  });
  const vol = new Map();
  for (let i = 0; i < N; i++) vol.set(C.r[i], (vol.get(C.r[i]) || 0) + 1);
  const sel = $("#estDest");
  [...F.dict.dests].sort().forEach((d) => { const o = document.createElement("option"); o.value = d; o.textContent = `${META.airport} → ${d}`; sel.appendChild(o); });
  const busiest = [...vol.entries()].sort((a, b) => b[1] - a[1])[0][0];
  sel.value = F.dict.dests[busiest];
  sel.addEventListener("change", renderEstimator);
  $("#estTime").addEventListener("input", renderEstimator);
  renderEstimator();
}
function bandOf(hour) {
  const i = M.band_hours.findIndex(([lo, hi]) => hour >= lo && hour < hi);
  return M.bands[i];
}
function estimate(dest, band) {
  const minN = M.metrics.min_group_size, g = GROUP.get(dest + "|" + band), b = BAND.get(band);
  if (g && g.n >= minN) return { ...g, level: "destination + time band" };
  if (b && b.n >= minN) return { ...b, level: `time-band fallback (only ${g ? g.n : 0} flights to ${dest} in this band)` };
  return { p: M.overall_rate, lo: NaN, hi: NaN, n: M.metrics.train_operated, level: "overall fallback" };
}
function renderEstimator() {
  const dest = $("#estDest").value, mins = +$("#estTime").value, hour = Math.floor(mins / 60);
  const t = String(hour).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  $("#estTimeOut").textContent = t;
  const band = bandOf(hour), e = estimate(dest, band), base = M.overall_rate;
  drawGauge(e, base);
  const hold = HOLD_BY_SLOT.get(dest + "|" + band);
  $("#estText").innerHTML = `${META.airport} &rarr; <b>${dest}</b> at <b>${t}</b> (${bandName(band)})<br>
    95% interval <b>${Number.isFinite(e.lo) ? pct(e.lo) + " to " + pct(e.hi) : "n/a"}</b> / based on <b>${int(e.n)}</b> training departures<br>
    ${(e.p / base).toFixed(2)}x the ${pct(base)} training baseline / source: ${e.level}<br>
    ${hold ? `Holdout check (${M.metrics.holdout_month}): this slot actually ran <b>${pct(hold[1] / hold[0])}</b> late (${hold[1]} of ${hold[0]})` : `No holdout flights in this slot`}`;
  $("#estMethod").textContent = `Probability = share of operated departures to this destination in this scheduled time band that left 15+ min late during ${M.metrics.train_months.join(" and ")}. Groups with fewer than ${M.metrics.min_group_size} flights use the time-band rate across all destinations (hollow bars). Whiskers are 95% Wilson intervals.`;
  drawBandProfile(dest, band, base);
}
function drawGauge(e, base) {
  const svg = clear($("#gauge")), cx = 160, cy = 160, r = 120;
  const pt = (v, rr = r) => { const a = Math.PI * (1 - Math.max(0, Math.min(1, v))); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
  const arc = (v0, v1, rr) => { const [x0, y0] = pt(v0, rr), [x1, y1] = pt(v1, rr); return `M${x0},${y0} A${rr},${rr} 0 0 1 ${x1},${y1}`; };
  svgEl("path", { d: arc(0, 1, r), stroke: "#1b2462", "stroke-width": 14, fill: "none" }, svg);
  for (let v = 0; v <= 1.0001; v += 0.1) {
    const [x0, y0] = pt(v, r + 12), [x1, y1] = pt(v, r + (v * 10 % 5 === 0 ? 20 : 16));
    svgEl("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "#2a3584" }, svg);
    if (Math.round(v * 10) % 5 === 0) { const [tx, ty] = pt(v, r + 32); svgEl("text", { x: tx, y: ty + 3, "text-anchor": "middle" }, svg).textContent = Math.round(v * 100) + "%"; }
  }
  if (Number.isFinite(e.lo)) svgEl("path", { d: arc(e.lo, e.hi, r), stroke: "#8f9bff", "stroke-opacity": 0.35, "stroke-width": 26, fill: "none" }, svg);
  svgEl("path", { d: arc(0, e.p, r), stroke: heatColor(e.p), "stroke-width": 14, fill: "none", "stroke-linecap": "butt" }, svg);
  const [bx0, by0] = pt(base, r - 14), [bx1, by1] = pt(base, r + 14);
  svgEl("line", { x1: bx0, y1: by0, x2: bx1, y2: by1, stroke: "#ffb547", "stroke-width": 2 }, svg);
  const [lx, ly] = pt(base, r - 26);
  svgEl("text", { x: lx, y: ly + 3, "text-anchor": "middle", fill: "#ffb547", "font-size": 9 }, svg).textContent = "BASE";
  svgEl("text", { x: cx, y: cy - 22, "text-anchor": "middle", fill: "#e8ebff", "font-size": 40, "font-weight": 500 }, svg).textContent = pct(e.p);
  svgEl("text", { x: cx, y: cy - 2, "text-anchor": "middle", fill: "#8790c4", "font-size": 9.5, "letter-spacing": "0.12em" }, svg).textContent = "P(DEPARTS 15+ MIN LATE)";
}
function drawBandProfile(dest, selBand, base) {
  const svg = clear($("#bandProfile")), W = 520, H = 300, pl = 40, pb = 46, pt = 14, bw = (W - pl - 10) / M.bands.length;
  const y = (v) => pt + (1 - v / 0.8) * (H - pt - pb);
  for (let v = 0; v <= 0.8001; v += 0.2) {
    svgEl("line", { x1: pl, x2: W - 10, y1: y(v), y2: y(v), class: "gridline" }, svg);
    svgEl("text", { x: pl - 6, y: y(v) + 3, "text-anchor": "end" }, svg).textContent = Math.round(v * 100) + "%";
  }
  M.bands.forEach((band, j) => {
    const e = estimate(dest, band), x = pl + j * bw + bw * 0.2, w = bw * 0.6, own = e.level.startsWith("destination");
    const sel = band === selBand;
    const rect = svgEl("rect", { x, y: y(e.p), width: w, height: y(0) - y(e.p), rx: 2,
      fill: own ? (sel ? heatColor(e.p) : "#26339e") : "transparent", stroke: own ? (sel ? "#fff" : "none") : "#3f51ff", "stroke-dasharray": own ? "" : "3 3" }, svg);
    if (Number.isFinite(e.lo)) {
      svgEl("line", { x1: x + w / 2, x2: x + w / 2, y1: y(e.lo), y2: y(e.hi), stroke: "#e8ebff", "stroke-width": 1 }, svg);
      for (const v of [e.lo, e.hi]) svgEl("line", { x1: x + w / 2 - 5, x2: x + w / 2 + 5, y1: y(v), y2: y(v), stroke: "#e8ebff" }, svg);
    }
    svgEl("text", { x: x + w / 2, y: H - pb + 16, "text-anchor": "middle", fill: sel ? "#e8ebff" : "#8790c4" }, svg).textContent = bandName(band).split(" ")[1];
    svgEl("text", { x: x + w / 2, y: H - pb + 30, "text-anchor": "middle", fill: "#545d97", "font-size": 9 }, svg).textContent = bandName(band).split(" ")[0].slice(0, 5).toUpperCase();
    rect.addEventListener("mousemove", (ev) => showTip(ev, `<b>${bandName(band)}</b><br>${pct(e.p)} / n=${int(e.n)}<br>${e.level}`));
    rect.addEventListener("mouseleave", hideTip);
  });
  svgEl("line", { x1: pl, x2: W - 10, y1: y(base), y2: y(base), stroke: "#ffb547", "stroke-dasharray": "5 5" }, svg);
  svgEl("text", { x: W - 10, y: y(base) - 5, "text-anchor": "end", fill: "#ffb547" }, svg).textContent = "BASELINE " + pct(base);
}

/* ------------------------------------------------------------------ 05 model */
let HP, HY;   // holdout probabilities and outcomes (operated flights only)
function initModel() {
  const mm = M.metrics, p = [], yv = [];
  M.holdout.row.forEach((row, j) => { if (C.s[row] <= 1) { p.push(M.holdout.p[j]); yv.push(C.s[row]); } });
  HP = Float64Array.from(p); HY = Uint8Array.from(yv);
  const k = (label, val, sub, cls = "") => `<div class="kpi ${cls}"><div class="k-label">${label}</div><div class="k-val">${val}</div><div class="k-sub">${sub}</div></div>`;
  $("#modelKpis").innerHTML =
    k("ROC AUC", mm.roc_auc.toFixed(3), "0.500 = coin flip / ranking quality", "ind") +
    k("TOP-10 ALERT PRECISION", pct(mm.alerts_delay_rate), `${mm.alerts_true_delays} of ${mm.alerts_operated} alerts were delayed`, "hi") +
    k("LIFT VS RANDOM", mm.lift_vs_holdout.toFixed(2) + "x", `holdout base rate ${pct(mm.holdout_delay_rate)}`) +
    k("BRIER SKILL", pct(mm.brier_skill), `Brier ${mm.brier_score.toFixed(3)} vs ${mm.brier_baseline.toFixed(3)} baseline`);
  $("#modelNote").textContent = `Trained on ${mm.train_months.join(" + ")}, tested on ${mm.holdout_month} (${int(mm.holdout_operated)} operated departures it never saw).`;
  $("#accuracyCaveat").textContent = `Why not just "accuracy"? Only ${pct(mm.holdout_delay_rate)} of holdout departures were delayed, so a model that always answers "on time" is ${pct(1 - mm.holdout_delay_rate)} accurate and useless. AUC measures ranking, calibration checks that a 40% score really means about 40%, and alert precision is what an operations desk actually experiences.`;
  $("#thr").addEventListener("input", renderThreshold);
  drawCalibration();
  renderThreshold();
}
function confusionAt(t) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < HP.length; i++) {
    const flag = HP[i] >= t;
    if (flag && HY[i]) tp++; else if (flag) fp++; else if (HY[i]) fn++; else tn++;
  }
  return { tp, fp, tn, fn };
}
function renderThreshold() {
  const t = +$("#thr").value, c = confusionAt(t), n = HP.length;
  $("#thrOut").textContent = "P >= " + t.toFixed(2);
  const prec = c.tp / (c.tp + c.fp), rec = c.tp / (c.tp + c.fn), acc = (c.tp + c.tn) / n;
  const cell = (v, label, cls) => `<div class="c ${cls}">${int(v)}<small>${label}</small></div>`;
  $("#confusion").innerHTML = `<div></div><div class="h">ACTUAL LATE</div><div class="h">ACTUAL ON TIME</div>
    <div class="h">FLAGGED</div>${cell(c.tp, "TRUE POSITIVE", "good")}${cell(c.fp, "FALSE ALARM", "err")}
    <div class="h">NOT FLAGGED</div>${cell(c.fn, "MISSED", "err")}${cell(c.tn, "TRUE NEGATIVE", "good")}`;
  $("#thrStats").innerHTML = `<span>Accuracy</span><span>${pct(acc)}</span><span>Precision</span><span>${pct(prec)}</span>
    <span>Recall</span><span>${pct(rec)}</span><span>F1</span><span>${((2 * prec * rec) / (prec + rec) || 0).toFixed(3)}</span>
    <span>Flagged</span><span>${pct((c.tp + c.fp) / n)} of flights</span>`;
  drawRoc(t);
}
let ROC = null;
function rocPoints() {
  if (ROC) return ROC;
  const order = [...HP.keys()].sort((a, b) => HP[b] - HP[a]);
  const P = HY.reduce((a, b) => a + b, 0), Nn = HY.length - P;
  const pts = [[0, 0, 1]];
  let tp = 0, fp = 0, auc = 0;
  for (let i = 0; i < order.length; i++) {
    HY[order[i]] ? tp++ : fp++;
    if (i === order.length - 1 || HP[order[i + 1]] !== HP[order[i]]) {
      const prev = pts[pts.length - 1], x = fp / Nn, y = tp / P;
      auc += (x - prev[0]) * (y + prev[1]) / 2;                      // trapezoid = ties count half
      pts.push([x, y, HP[order[i]]]);
    }
  }
  ROC = { pts, auc };
  return ROC;
}
function axes(svg, W, H, pl, pb, xl, yl) {
  const g = svgEl("g", { class: "axis" }, svg);
  for (let v = 0; v <= 1.0001; v += 0.25) {
    const x = pl + v * (W - pl - 10), y = 10 + (1 - v) * (H - 10 - pb);
    svgEl("line", { x1: pl, x2: W - 10, y1: y, y2: y, class: "gridline" }, g);
    svgEl("line", { x1: x, x2: x, y1: 10, y2: H - pb, class: "gridline" }, g);
    svgEl("text", { x: x, y: H - pb + 14, "text-anchor": "middle" }, g).textContent = v.toFixed(2);
    svgEl("text", { x: pl - 6, y: y + 3, "text-anchor": "end" }, g).textContent = v.toFixed(2);
  }
  svgEl("text", { x: (pl + W) / 2, y: H - 4, "text-anchor": "middle", fill: "#545d97" }, g).textContent = xl;
  svgEl("text", { x: 10, y: (H - pb) / 2, "text-anchor": "middle", fill: "#545d97", transform: `rotate(-90 10 ${(H - pb) / 2})` }, g).textContent = yl;
  return { x: (v) => pl + v * (W - pl - 10), y: (v) => 10 + (1 - v) * (H - 10 - pb) };
}
function drawRoc(t) {
  const svg = clear($("#roc")), { pts, auc } = rocPoints();
  const s = axes(svg, 320, 300, 40, 38, "FALSE POSITIVE RATE", "TRUE POSITIVE RATE");
  svgEl("line", { x1: s.x(0), y1: s.y(0), x2: s.x(1), y2: s.y(1), stroke: "#545d97", "stroke-dasharray": "4 4" }, svg);
  svgEl("path", { d: "M" + pts.map(([x, y]) => `${s.x(x).toFixed(1)},${s.y(y).toFixed(1)}`).join(" L"), fill: "none", stroke: "#8f9bff", "stroke-width": 2 }, svg);
  let cur = pts[0];
  for (const q of pts) if (q[2] >= t) cur = q;
  svgEl("circle", { cx: s.x(cur[0]), cy: s.y(cur[1]), r: 5, fill: "#ffb547", stroke: "#04061a", "stroke-width": 2 }, svg);
  $("#aucOut").textContent = "AUC " + auc.toFixed(3);
}
function drawCalibration() {
  const svg = clear($("#calib")), data = M.metrics.calibration_deciles, top = 0.6;
  const W = 320, H = 300, pl = 40, pb = 38;
  const x = (v) => pl + (v / top) * (W - pl - 10), y = (v) => 10 + (1 - v / top) * (H - 10 - pb);
  for (let v = 0; v <= top + 1e-9; v += 0.2) {
    svgEl("line", { x1: pl, x2: W - 10, y1: y(v), y2: y(v), class: "gridline" }, svg);
    svgEl("line", { x1: x(v), x2: x(v), y1: 10, y2: H - pb, class: "gridline" }, svg);
    svgEl("text", { x: x(v), y: H - pb + 14, "text-anchor": "middle" }, svg).textContent = Math.round(v * 100) + "%";
    svgEl("text", { x: pl - 6, y: y(v) + 3, "text-anchor": "end" }, svg).textContent = Math.round(v * 100) + "%";
  }
  svgEl("text", { x: (pl + W) / 2, y: H - 4, "text-anchor": "middle", fill: "#545d97" }, svg).textContent = "PREDICTED PROBABILITY";
  svgEl("text", { x: 10, y: (H - pb) / 2, "text-anchor": "middle", fill: "#545d97", transform: `rotate(-90 10 ${(H - pb) / 2})` }, svg).textContent = "OBSERVED DELAY RATE";
  svgEl("line", { x1: x(0), y1: y(0), x2: x(top), y2: y(top), stroke: "#545d97", "stroke-dasharray": "4 4" }, svg);
  svgEl("path", { d: "M" + data.map((d) => `${x(d.predicted)},${y(d.observed)}`).join(" L"), fill: "none", stroke: "#3f51ff", "stroke-width": 1.5 }, svg);
  data.forEach((d) => {
    const c = svgEl("circle", { cx: x(d.predicted), cy: y(d.observed), r: 5, fill: heatColor(d.observed), stroke: "#04061a", "stroke-width": 1.5 }, svg);
    c.addEventListener("mousemove", (e) => showTip(e, `<b>Decile ${d.decile}</b><br>predicted ${pct(d.predicted)}<br>observed ${pct(d.observed)}<br>${int(d.flights)} flights`));
    c.addEventListener("mouseleave", hideTip);
  });
}

/* ------------------------------------------------------------------ 06 watchlist */
let ALERTS_BY_DAY;
function initWatchlist() {
  ALERTS_BY_DAY = new Map();
  M.holdout.row.forEach((row, j) => {
    if (!M.holdout.alert[j]) return;
    const d = C.d[row];
    if (!ALERTS_BY_DAY.has(d)) ALERTS_BY_DAY.set(d, []);
    ALERTS_BY_DAY.get(d).push({ row, p: M.holdout.p[j] });
  });
  const days = [...ALERTS_BY_DAY.keys()].sort((a, b) => a - b);
  const strip = $("#dayStrip");
  days.forEach((d) => {
    const list = ALERTS_BY_DAY.get(d), hits = list.filter((a) => C.s[a.row] === 1).length;
    const b = document.createElement("button");
    b.type = "button"; b.className = "day"; b.dataset.d = d;
    b.innerHTML = `${F.dict.dates[d].slice(8)}<i style="opacity:${0.15 + (hits / list.length) * 0.85}"></i>`;
    b.title = `${F.dict.dates[d]}: ${hits} of ${list.length} alerts were delayed`;
    b.addEventListener("click", () => { state.day = d; renderWatch(); });
    strip.appendChild(b);
  });
  state.day = days[0];
  renderWatch();
}
function renderWatch() {
  document.querySelectorAll(".day").forEach((b) => b.classList.toggle("on", +b.dataset.d === state.day));
  const list = [...ALERTS_BY_DAY.get(state.day)].sort((a, b) => b.p - a.p || C.t[a.row] - C.t[b.row]);
  $("#watchTable tbody").innerHTML = list.map((a, i) => {
    const r = a.row, s = C.s[r];
    const out = s === 2 ? `<span class="tag cx">CANCELLED</span>` : s === 3 ? `<span class="tag cx">NO OUTCOME</span>`
      : s === 1 ? `<span class="tag bad">LATE ${C.dd[r]} MIN</span>` : `<span class="tag ok">ON TIME${C.dd[r] > 0 ? " +" + C.dd[r] : ""}</span>`;
    return `<tr><td class="muted">${String(i + 1).padStart(2, "0")}</td><td>${hhmm(C.t[r])}</td>
      <td>${F.dict.carriers[C.c[r]]} ${C.fn[r] || ""}</td><td>${META.airport} &rarr; ${F.dict.dests[C.r[r]]}</td>
      <td class="muted">${bandName(bandOf(C.h[r]))}</td><td class="num">${pct(a.p)}</td><td>${out}</td></tr>`;
  }).join("");
}

boot().catch((err) => {
  $("#loader").innerHTML = `FAILED TO LOAD DATA<br><span style="color:#8790c4">${err.message}. Run python export_web.py, then serve the web/ folder.</span>`;
});
