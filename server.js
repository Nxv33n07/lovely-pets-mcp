/**
 * server.js — LovelyPets VetBuddy Scaled MCP Server
 * ─────────────────────────────────────────────────
 * Runs as a classic SSE HTTP server (SSEServerTransport) connecting
 * Claude to the scaled dummy analytics RDS Database for Lovely Pets.
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  SSEServerTransport,
} = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const axios = require("axios");
const vb = require("./vetbuddy.js");
const db = require("./db.js");

const activeTransports = new Map();

const app = express();
const PORT = process.env.PORT || 3001; // Distinct port for the Lovely Pets local listener

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id",
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const safeNum = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const today = () =>
  new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
const isoToVB = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};
const ok = (d) => ({
  content: [{ type: "text", text: JSON.stringify(d, null, 2) }],
});
const err = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message || e}` }],
  isError: true,
});

// ── Dashboard HTML formatter — Chart.js powered ──────────────────────────────
function buildDashboardText(data, opp) {
  const {
    fromDate,
    toDate,
    totalRevenue,
    invoiceCount,
    totalCollected,
    dayRevenue,
    nightRevenue,
    dayInvoices,
    nightInvoices,
    species,
    catTotals,
    subCategories,
    newClients,
    returningClients,
    stock,
    paymentsBreakdown,
    returnedPayments,
    revenueSplit,
    invoiceSplit,
  } = data;
  const { thisWeek, lastWeek, thisMonth, lastMonth } = opp;

  const INR = (v) => "₹" + Math.round(v || 0).toLocaleString("en-IN");
  const PCT = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0") + "%";
  const CHG = (a, b) => {
    if (!b) return { txt: "—", up: null };
    const d = (((a - b) / b) * 100).toFixed(1);
    return { txt: (d > 0 ? "+" : "") + d + "%", up: Number(d) > 0 };
  };
  const J = JSON.stringify;
  const periodDays = Math.max(
    1,
    Math.round((new Date(toDate) - new Date(fromDate)) / 86400000) + 1,
  );
  const avgDaily = totalRevenue / periodDays;

  const outstanding = totalRevenue - totalCollected;
  const collRate = totalRevenue
    ? ((totalCollected / totalRevenue) * 100).toFixed(1)
    : "0";
  const avgInv = invoiceCount ? totalRevenue / invoiceCount : 0;
  const wChg = CHG(thisWeek.rev, lastWeek.rev);

  const CAT_COLORS = {
    Prescription: "#ef4444",
    Laboratory: "#3b82f6",
    Hospitalization: "#8b5cf6",
    Consultation: "#10b981",
    Food: "#f59e0b",
    Grooming: "#ec4899",
    Others: "#64748b",
  };
  const catLabels = Object.keys(catTotals).filter((k) => catTotals[k] > 0);
  const catVals = catLabels.map((k) => Math.round(catTotals[k]));
  const catColors = catLabels.map((k) => CAT_COLORS[k] || "#64748b");
  const pmts = paymentsBreakdown || [];
  const CAT_KEYS = [
    "Prescription",
    "Laboratory",
    "Hospitalization",
    "Consultation",
    "Food",
    "Grooming",
    "Others",
  ];

  const topCatEntry = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
  const topSpeciesEntry = Object.entries(species).sort(
    (a, b) => b[1].revenue - a[1].revenue,
  )[0];
  const collRateNum = parseFloat(collRate);
  const collStatus =
    collRateNum >= 85
      ? { icon: "✅", msg: "Excellent collection", col: "#10b981" }
      : collRateNum >= 60
        ? { icon: "⚠️", msg: "Collections need attention", col: "#f59e0b" }
        : { icon: "🚨", msg: "Critical: low collections", col: "#ef4444" };

  const kpiCard = (label, value, sub, accent, badgeTxt, badgeUp) =>
    `<div class="kpi" style="--a:${accent}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-val">${value}</div>
      <div class="kpi-sub">${sub}</div>
      ${badgeTxt ? `<span class="badge ${badgeUp === true ? "up" : badgeUp === false ? "dn" : "neu"}">${badgeTxt}</span>` : ""}
    </div>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lovely Pets Analytics Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#060b14;color:#e2e8f0;padding:24px;min-height:100vh}
.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:20px 24px;background:linear-gradient(135deg,#0f1e3a 0%,#0a1628 100%);border:1px solid #1e3a5f;border-radius:16px}
.hdr-title{font-size:24px;font-weight:900;background:linear-gradient(135deg,#ec4899,#a78bfa,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px}
.hdr-sub{font-size:12px;color:#475569;margin-top:3px}
.hdr-right{text-align:right}
.hdr-date{font-size:14px;font-weight:700;color:#93c5fd}
.hdr-ts{font-size:11px;color:#334155;margin-top:3px}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.sum-card{padding:14px 16px;border-radius:12px;border:1px solid;position:relative;overflow:hidden}
.sum-icon{font-size:20px;margin-bottom:6px}
.sum-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;opacity:.7}
.sum-val{font-size:16px;font-weight:800;margin-top:2px}
.sum-hint{font-size:10px;opacity:.6;margin-top:2px}
.sec{font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:1.2px;margin:20px 0 10px;display:flex;align-items:center;gap:10px}
.sec::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#1e293b,transparent)}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px}
.kpi{background:linear-gradient(145deg,#111d35,#0d1626);border:1px solid #1e3352;border-radius:14px;padding:16px 14px;position:relative;overflow:hidden;transition:border-color .2s}
.kpi:hover{border-color:#ec4899}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--a);border-radius:14px 14px 0 0}
.kpi-label{font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.kpi-val{font-size:19px;font-weight:900;color:#f1f5f9;letter-spacing:-.5px;line-height:1;margin-bottom:4px}
.kpi-sub{font-size:10px;color:#334155;margin-bottom:6px}
.badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:700}
.badge.up{background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.2)}
.badge.dn{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
.badge.neu{background:rgba(100,116,139,.12);color:#64748b;border:1px solid rgba(100,116,139,.2)}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid211{display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px;margin-bottom:14px}
.card{background:linear-gradient(145deg,#111d35,#0d1626);border:1px solid #1e3352;border-radius:14px;padding:18px}
.ctitle{font-size:10px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.9px;margin-bottom:14px;display:flex;align-items:center;gap:6px}
.ch-xs{position:relative;height:160px}
.ch-sm{position:relative;height:200px}
.ch-md{position:relative;height:260px}
.ch-lg{position:relative;height:300px}
.ch-xl{position:relative;height:340px}
.leg{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.leg-i{display:flex;align-items:center;gap:5px;font-size:11px;color:#94a3b8}
.leg-val{font-weight:700;color:#e2e8f0}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.srow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #0f1e35}
.srow:last-child{border-bottom:none}
.slabel{font-size:11px;color:#475569}
.sval{font-size:13px;font-weight:700;color:#e2e8f0}
.alert-row{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-radius:8px;margin-bottom:4px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.12)}
.alert-name{font-size:11px;color:#fca5a5;flex:1;font-weight:500}
.alert-qty{font-size:12px;color:#ef4444;font-weight:800}
.stk-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #0f1e35}
.stk-row:last-child{border-bottom:none}
.stk-name{font-size:11px;color:#94a3b8;flex:1}
.stk-val{font-size:11px;font-weight:700;color:#f59e0b}
.stk-qty{font-size:10px;color:#475569}
.footer{text-align:center;padding:20px 0 4px;color:#1e293b;font-size:10px}
</style></head><body>

<!-- ═══════ HEADER ═══════ -->
<div class="hdr">
  <div>
    <div class="hdr-title">🐾 Lovely Pets Veterinary Clinic</div>
    <div class="hdr-sub">SCALED DUMMY Business Intelligence Dashboard · Multi-Entity Analytics</div>
  </div>
  <div class="hdr-right">
    <div class="hdr-date">${isoToVB(fromDate)} → ${isoToVB(toDate)} &nbsp;(${periodDays}d)</div>
    <div class="hdr-ts">Generated ${new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
  </div>
</div>

<!-- ═══════ EXECUTIVE SUMMARY ═══════ -->
<div class="sec">📋 Executive Summary</div>
<div class="summary">
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(236,72,153,.08),transparent);border-color:rgba(236,72,153,.25)">
    <div class="sum-icon">💰</div>
    <div class="sum-label">Synthetic Revenue</div>
    <div class="sum-val" style="color:#ec4899">${INR(totalRevenue)}</div>
    <div class="sum-hint">${INR(avgDaily)}/day avg · ${invoiceCount} invoices</div>
  </div>
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(${collRateNum >= 85 ? "16,185,129" : collRateNum >= 60 ? "245,158,11" : "239,68,68"},.08),transparent);border-color:rgba(${collRateNum >= 85 ? "16,185,129" : collRateNum >= 60 ? "245,158,11" : "239,68,68"},.25)">
    <div class="sum-icon">${collStatus.icon}</div>
    <div class="sum-label">Collections</div>
    <div class="sum-val" style="color:${collStatus.col}">${collRate}% rate</div>
    <div class="sum-hint">${INR(outstanding)} outstanding</div>
  </div>
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(139,92,246,.08),transparent);border-color:rgba(139,92,246,.25)">
    <div class="sum-icon">🏆</div>
    <div class="sum-label">Top Category</div>
    <div class="sum-val" style="color:#a78bfa">${topCatEntry?.[0] || "—"}</div>
    <div class="sum-hint">${INR(topCatEntry?.[1] || 0)} · ${PCT(topCatEntry?.[1] || 0, totalRevenue)} of revenue</div>
  </div>
  <div class="sum-card" style="background:linear-gradient(135deg,rgba(16,185,129,.08),transparent);border-color:rgba(16,185,129,.25)">
    <div class="sum-icon">🐾</div>
    <div class="sum-label">Top Species</div>
    <div class="sum-val" style="color:#34d399">${topSpeciesEntry?.[0] || "—"}</div>
    <div class="sum-hint">${topSpeciesEntry?.[1]?.visits || 0} visits · ${INR(topSpeciesEntry?.[1]?.revenue || 0)}</div>
  </div>
</div>

<!-- ═══════ KPI CARDS ═══════ -->
<div class="sec">💰 Scaled KPIs</div>
<div class="kpis">
  ${kpiCard("Total Revenue", INR(totalRevenue), `${invoiceCount} invoices · ${periodDays}d`, "#ec4899", wChg.txt + " WoW", wChg.up)}
  ${kpiCard("Collected", INR(totalCollected), "Payments received", "#10b981", collRate + "% collection rate", collRateNum >= 85 ? true : collRateNum >= 60 ? null : false)}
  ${kpiCard("Outstanding", INR(outstanding), PCT(outstanding, totalRevenue) + " of billed", "#ef4444", "", null)}
  ${kpiCard("Avg / Invoice", INR(avgInv), `vs ${INR(avgDaily)}/day avg`, "#f59e0b", "", null)}
  ${kpiCard("New Clients", String(newClients), PCT(newClients, newClients + returningClients) + " of visits", "#8b5cf6", "", null)}
  ${kpiCard("Returning", String(returningClients), PCT(returningClients, newClients + returningClients) + " of visits", "#60a5fa", "", null)}
</div>

<!-- ═══════ CORE BREAKDOWNS ═══════ -->
<div class="sec">📊 Core Breakdowns</div>
<div class="grid3">
  <div class="card">
    <div class="ctitle">🌅 Day vs Night — Invoices</div>
    <div class="ch-sm"><canvas id="cDayNight"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#f59e0b"></div>Day &nbsp;<span class="leg-val">${dayInvoices} inv</span></div>
      <div class="leg-i"><div class="dot" style="background:#6366f1"></div>Night &nbsp;<span class="leg-val">${nightInvoices} inv</span></div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">🐕🐈 Species Breakdown</div>
    <div class="ch-sm"><canvas id="cSpecies"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>🐕 Dog &nbsp;<span class="leg-val">${INR(species.Canine.revenue)}</span></div>
      <div class="leg-i"><div class="dot" style="background:#a78bfa"></div>🐈 Cat &nbsp;<span class="leg-val">${INR(species.Feline.revenue)}</span></div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">👥 New vs Returning Clients</div>
    <div class="ch-sm"><canvas id="cCustomer"></canvas></div>
    <div class="leg">
      <div class="leg-i"><div class="dot" style="background:#10b981"></div>New &nbsp;(${PCT(newClients, newClients + returningClients)})</div>
      <div class="leg-i"><div class="dot" style="background:#3b82f6"></div>Ret &nbsp;(${PCT(returningClients, newClients + returningClients)})</div>
    </div>
  </div>
</div>

<!-- ═══════ CATEGORY DONUT + SUB-CATEGORY BAR ═══════ -->
<div class="sec">📈 Category Revenue</div>
<div class="grid2">
  <div class="card">
    <div class="ctitle">💊 Revenue by Category</div>
    <div class="ch-lg"><canvas id="cCategory"></canvas></div>
  </div>
  <div class="card">
    <div class="ctitle">📊 Sub-Category Sales — Top 12</div>
    <div class="ch-lg"><canvas id="cSubCat"></canvas></div>
  </div>
</div>

${
  stock
    ? `
<!-- ═══════ INVENTORY ═══════ -->
<div class="sec">📦 Inventory — Closing Stock, Alerts & Mismatches</div>
<div class="grid211">
  <div class="card">
    <div class="ctitle">📊 Inventory Distribution</div>
    <div style="display:flex;gap:22px;align-items:center">
      <div style="width:170px;flex-shrink:0;position:relative;height:170px"><canvas id="cInv"></canvas></div>
      <div style="flex:1">
        <div class="srow"><span class="slabel">Total SKUs</span><span class="sval">${stock.totalItems.toLocaleString()}</span></div>
        <div class="srow"><span class="slabel">Closing Value</span><span class="sval" style="color:#ec4899">${INR(stock.valuation)}</span></div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">⚠️ Neg / Out Stock Mismatch</div>
    ${
      stock.negativeItems?.length > 0
        ? stock.negativeItems
            .slice(0, 8)
            .map(
              (i) =>
                `<div class="alert-row"><span class="alert-name">${i.name}</span><span class="alert-qty">${i.onhand_qty}</span></div>`,
            )
            .join("")
        : `<div style="font-size:12px;color:#10b981;padding:10px 0">✅ No mismatches detected</div>`
    }
  </div>
  <div class="card">
    <div class="ctitle">🔴 Low Stock Alerts</div>
    ${
      stock.lowItems?.length > 0
        ? stock.lowItems
            .slice(0, 5)
            .map(
              (i) =>
                `<div class="stk-row"><span class="stk-name">• ${i.name}</span><span class="stk-val">${i.onhand_qty}/${i.threshold_qty}</span></div>`,
            )
            .join("")
        : `<div style="color:#334155;font-size:11px">No low items</div>`
    }
  </div>
</div>
`
    : ""
}

<div class="footer">Lovely Pets Intelligence Hub · Powered by Scaled RDS Warehouse</div>

<script>
Chart.register(ChartDataLabels);
Chart.defaults.color='#64748b';
Chart.defaults.borderColor='#0f1e35';
Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
Chart.defaults.font.size=11;

const inr=v=>'₹'+Math.round(v||0).toLocaleString('en-IN');
const pct=(a,b)=>b?((a/b)*100).toFixed(1)+'%':'0%';
const fmtK=v=>v>=1e5?'₹'+(v/1e5).toFixed(1)+'L':v>=1e3?'₹'+(v/1e3).toFixed(0)+'K':'₹'+v;

const DL_PCT={id:'datalabels',formatter:(v,ctx)=>{const t=ctx.dataset.data.reduce((a,b)=>a+b,0);return t&&v/t>.04?((v/t)*100).toFixed(0)+'%':'';},color:'#fff',font:{weight:'700',size:11},textStrokeColor:'rgba(0,0,0,.4)',textStrokeWidth:2};

new Chart(document.getElementById('cDayNight'),{type:'doughnut',data:{labels:['Day','Night'],datasets:[{data:[${dayInvoices},${nightInvoices}],backgroundColor:['#f59e0b','#6366f1'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},datalabels:DL_PCT}}});
new Chart(document.getElementById('cSpecies'),{type:'doughnut',data:{labels:['🐕 Dog','🐈 Cat','Others'],datasets:[{data:[${Math.round(species.Canine.revenue)},${Math.round(species.Feline.revenue)},${Math.round(species.Others.revenue)}],backgroundColor:['#3b82f6','#a78bfa','#475569'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},datalabels:DL_PCT}}});
new Chart(document.getElementById('cCustomer'),{type:'doughnut',data:{labels:['New','Returning'],datasets:[{data:[${newClients},${returningClients}],backgroundColor:['#10b981','#3b82f6'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},datalabels:DL_PCT}}});

new Chart(document.getElementById('cCategory'),{type:'doughnut',data:{labels:${J(catLabels)},datasets:[{data:${J(catVals)},backgroundColor:${J(catColors)},borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'50%',plugins:{legend:{display:true,position:'right'},datalabels:DL_PCT}}});
new Chart(document.getElementById('cSubCat'),{type:'bar',data:{labels:${J(subCategories.slice(0, 12).map((s) => (s.name.length > 22 ? s.name.slice(0, 20) + "…" : s.name)))},datasets:[{data:${J(subCategories.slice(0, 12).map((s) => Math.round(s.revenue)))},backgroundColor:'#ec4899',borderRadius:5}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:'#0f1e35'},ticks:{callback:fmtK}},y:{grid:{display:false}}}}});

${
  stock
    ? `
new Chart(document.getElementById('cInv'),{type:'doughnut',data:{labels:['Adequate','Low','Out','Negative'],datasets:[{data:[${stock.adequateCount},${stock.lowCount},${stock.outCount},${stock.negativeCount}],backgroundColor:['#10b981','#f59e0b','#ef4444','#fbbf24'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'60%',plugins:{legend:{display:false},datalabels:DL_PCT}}});
`
    : ""
}
<\/script></body></html>`;
}

// ── Dashboard query wrapper ───────────────────────────────────────────────────
async function getDashboard(fromIso, toIso) {
  const countRows = await db.query(
    `SELECT COUNT(*) AS cnt FROM lovely_invoices
     WHERE DATE(invoice_date) BETWEEN ? AND ?`,
    [fromIso, toIso],
  );
  if (+countRows[0].cnt === 0) {
    throw new Error(
      `No data generated in DB for ${fromIso} → ${toIso}. Please run 'npm run generate' on your server or scale factor manually first.`,
    );
  }
  const [data, opp] = await Promise.all([
    db.queryDashboard(fromIso, toIso),
    db.queryOpportunity(),
  ]);
  return buildDashboardText(data, opp);
}

// ── SVG chart generator ───────────────────────────────────────────────────────
function buildChartSVG(title, summary, kpis, charts) {
  const W = 780;
  const PAL = ["#ec4899", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inr = (v) => "₹" + Math.round(v || 0).toLocaleString("en-IN");
  const fmt = (v, currency) => currency ? inr(v) : String(Math.round(v));
  const parts = [];
  let y = 16;

  const wrap = (text, maxCh) => {
    const words = String(text).split(" ");
    const lines = [];
    let cur = "";
    for (const w of words) {
      if ((cur ? cur + " " + w : w).length > maxCh) {
        if (cur) lines.push(cur);
        cur = w;
      } else cur = cur ? cur + " " + w : w;
    }
    if (cur) lines.push(cur);
    return lines;
  };

  parts.push(`<rect x="0" y="0" width="${W}" height="${y + 34}" fill="#fff" rx="10"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="4" fill="#ec4899" rx="10"/>`);
  parts.push(`<text x="14" y="${y + 22}" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="700" fill="#202124">${esc(title)}</text>`);
  y += 48;

  if (summary) {
    const lines = wrap(summary, 95);
    const bh = lines.length * 18 + 16;
    parts.push(`<rect x="0" y="${y}" width="${W}" height="${bh}" fill="#fdf2f8" rx="8"/>`);
    parts.push(`<rect x="0" y="${y}" width="4" height="${bh}" fill="#ec4899" rx="2"/>`);
    lines.forEach((l, i) => parts.push(`<text x="12" y="${y + 18 + i * 18}" font-family="Arial,Helvetica,sans-serif" font-size="12" fill="#be185d">${esc(l)}</text>`));
    y += bh + 14;
  }

  if (kpis.length) {
    const n = Math.min(kpis.length, 6);
    const cw = Math.floor((W - 10 * (n + 1)) / n);
    const ch = 85;
    for (let i = 0; i < n; i++) {
      const k = kpis[i];
      const cx = 10 + i * (cw + 10);
      const acc = k.accent || PAL[i % PAL.length];
      parts.push(`<rect x="${cx}" y="${y}" width="${cw}" height="${ch}" fill="#fff" stroke="#dadce0" stroke-width="1" rx="8"/>`);
      parts.push(`<rect x="${cx}" y="${y}" width="${cw}" height="3" fill="${acc}" rx="3"/>`);
      parts.push(`<text x="${cx + 10}" y="${y + 20}" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#9aa0a6">${esc((k.label || "").toUpperCase())}</text>`);
      parts.push(`<text x="${cx + 10}" y="${y + 52}" font-family="Arial,Helvetica,sans-serif" font-size="19" font-weight="800" fill="#202124">${esc(k.value || "")}</text>`);
    }
    y += ch + 16;
  }

  for (const ch of charts) {
    parts.push(`<text x="14" y="${y + 14}" font-family="Arial,Helvetica,sans-serif" font-size="10" font-weight="700" fill="#9aa0a6" letter-spacing="0.8">${esc((ch.title || "").toUpperCase())}</text>`);
    y += 24;

    if (ch.type === "doughnut" || ch.type === "pie") {
      const R = 70;
      const ox = 110;
      const oy = y + R + 10;
      const total = ch.datasets[0].data.reduce((a, b) => a + b, 0) || 1;
      let ang = -Math.PI / 2;
      ch.datasets[0].data.forEach((val, i) => {
        if (!val) return;
        const sweep = (val / total) * 2 * Math.PI;
        const ea = ang + sweep;
        const lg = sweep > Math.PI ? 1 : 0;
        const color = PAL[i % PAL.length];
        const [x1, y1] = [ox + R * Math.cos(ang), oy + R * Math.sin(ang)];
        const [x2, y2] = [ox + R * Math.cos(ea), oy + R * Math.sin(ea)];
        parts.push(`<path d="M${ox},${oy} L${x1},${y1} A${R},${R} 0 ${lg},1 ${x2},${y2}Z" fill="${color}"/>`);
        ang = ea;
      });
      y = oy + R + 20;
    } else {
      const isH = ch.type === "horizontalBar" || ch.labels.length > 5;
      const maxVal = Math.max(...ch.datasets[0].data, 1);
      if (isH) {
        const labelW = 130;
        const barAreaW = W - labelW - 100;
        ch.labels.forEach((label, i) => {
          const val = ch.datasets[0].data[i] || 0;
          const bw = Math.max((val / maxVal) * barAreaW, 3);
          parts.push(`<text x="14" y="${y + 15}" font-family="Arial,Helvetica,sans-serif" font-size="11" fill="#5f6368">${esc(label.slice(0,18))}</text>`);
          parts.push(`<rect x="${labelW}" y="${y + 4}" width="${bw}" height="14" rx="3" fill="${PAL[0]}"/>`);
          parts.push(`<text x="${labelW + bw + 8}" y="${y + 15}" font-family="Arial,Helvetica,sans-serif" font-size="10" fill="#5f6368">${esc(fmt(val, ch.currency))}</text>`);
          y += 22;
        });
        y += 10;
      }
    }
    y += 12;
  }

  y += 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><rect width="${W}" height="${y}" fill="#fdfbfd" rx="12"/>${parts.join("")}</svg>`;
}

// ── Build MCP server ──────────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "lovelypets-intelligence", version: "1.0.0" });

  server.prompt(
    "intelligence_analyst",
    "Lovely Pets analytical instructions — read before business questions",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are the Lead Intelligence Analyst for Lovely Pets Veterinary clinic group.
Your business analysis is powered by a high-fidelity, scaled synthetic relational warehouse on AWS RDS. 

🚨 CRITICAL TOKEN EFFICIENCY NOTICE: 
We are using a strict Free Tier account today! You MUST guard tokens aggressively.
- NEVER request massive raw transactions. 
- ALWAYS shift heavy lifting to SQL: use SUM(), AVG(), COUNT(), and GROUP BY.
- Keep relational outputs tightly focused. Free-tier credits will run out quickly if queries are not aggregated.

ALL numeric or business questions must be answered via 'execute_sql' and supported immediately by 'render_chart'!

═══ LOVELY PETS RDS SCHEMA ═════════════════════════════════════════════
TABLE: lovely_invoices
  - invoice_id, invoice_date (DATETIME), invoice_amount (DECIMAL)
  - shift ENUM('Day','Night'), cancelled (1=true, 0=active), is_new_client, client_id
TABLE: lovely_invoice_items
  - invoice_id, invoice_date, item_total (REVENUE), species_group ('Canine','Feline','Others')
  - std_category ('Prescription'|'Laboratory'|'Hospitalization'|'Consultation'|'Food'|'Grooming'|'Others'), sales_id, patient_id
TABLE: lovely_payments
  - payment_id, payment_date, payment_amount, returned (1=true,0=active), payment_type_name, client_id, clinic_id
TABLE: lovely_stock
  - stock_id, clinic_name, stock_name, plan_category_name, std_category, onhand_qty, threshold_qty, purchase_cost, stock_status
TABLE: lovely_clients
  - client_id, first_name, last_name, clinic_name, email, mobile_phone, city, status
TABLE: lovely_patients
  - patient_id, patient_name, client_id, birth_date, species, breed, gender, neutered, status
TABLE: lovely_appointments
  - appointment_id, client_id, patient_id, clinic_name, appointment_start_time, appointment_end_time, appointment_status, appointment_type_name, reason_for_visit, staff_id
TABLE: lovely_staff
  - staff_id, staff_name, role

═══ WORKFLOW & TOOLS ══════════════════════════════════════════════════
For complex custom aggregations or charting queries:
1. Run custom read-only SELECTs via 'execute_sql'.
2. Immediately render high-res graphs and tables via 'render_chart'. Never output text alone for numeric analytics.

For specialized lookups, ALWAYS prefer these God-Level optimized tools:
- Directory Searches: Call 'search_directory' when finding clients or patients by name or contact.
- Electronic Medical Summary: Call 'get_patient_card' when the user asks about a specific pet's health, history, or diagnostics.
- Inventory & Capital Lockup: Call 'get_stock_intelligence' for critical alerts, quantity deficits, or stock capital evaluations.
- Speed Performance Pulse: Call 'get_business_pulse' to pull high-level gross/net cash and appointment volume KPIs for any period without writing complex SQL.

Filter 'cancelled=0' for revenues and 'returned=0' for payments. Write impactful business insights referencing the visual trends!`,
          },
        },
      ],
    }),
  );

  // ── SQL ENGINE (TOKEN-SHIELD EDITION) ──────────────────────────────────────
  server.tool(
    "execute_sql",
    `PRIMARY ANALYTIC ENGINE — Executes read-only SQL. 
TOKEN SAFETY RULE: Free accounts have strict token quotas. 
1. NEVER SELECT * on transactional tables without a tight LIMIT. 
2. ALWAYS prefer AGGREGATED data (using GROUP BY, COUNT, SUM, AVG) over raw transaction lists.
3. Charts only need ~15-30 data points, so keep results highly grouped and concise.
TABLES: lovely_invoices, lovely_invoice_items, lovely_payments, lovely_stock, lovely_clients, lovely_patients, lovely_appointments, lovely_staff.`,
    {
      sql_query: z.string().describe("Highly-aggregated SQL SELECT statement. Use SUM/GROUP BY wherever possible."),
    },
    async ({ sql_query }) => {
      try {
        const upper = sql_query.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("SHOW") && !upper.startsWith("DESCRIBE") && !upper.startsWith("EXPLAIN")) {
          throw new Error("Read-only guard: Only SELECT, SHOW, DESCRIBE, and EXPLAIN operations are permitted.");
        }
        
        const startTime = Date.now();
        const rows = await db.query(sql_query);
        const elapsedMs = Date.now() - startTime;

        return ok({
          metadata: {
            total_rows_found: rows.length,
            execution_time_ms: elapsedMs,
            note: "Aggressive Token Shield enabled: Output strictly capped at 60 rows to prevent account quota exhaustion. Shift details to SQL aggregation."
          },
          // Aggressive 60-row slice to perfectly protect Free Tier token budgets!
          rows: rows.slice(0, 60),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── ADVANCED VISUAL INTELLIGENCE ENGINE ─────────────────────────────────────
  server.tool(
    "render_chart",
    "ALWAYS call this immediately after execute_sql. Generates dynamic professional inline visualizations (Bar, Line, Doughnut, etc.) + KPI tables.",
    {
      title: z.string().describe("Headline of the dashboard view"),
      summary: z.string().optional().describe("2-3 sentence executive insight summarizing the chart findings"),
      kpis: z.array(z.object({
        label: z.string(),
        value: z.string().describe("Formatted string, e.g. '₹4.2L' or '5,203'"),
        trend: z.string().optional().describe("Growth trend badge like '+12%' or '↓5%'"),
        accent: z.string().optional().describe("Optional theme color code")
      })).optional().describe("Top level metrics cards"),
      charts: z.array(z.object({
        id: z.string(),
        type: z.enum(["bar", "doughnut", "line", "horizontalBar", "pie"]),
        title: z.string(),
        labels: z.array(z.string()),
        datasets: z.array(z.object({
          label: z.string().optional(),
          data: z.array(z.number()),
          color: z.string().optional(),
          colors: z.array(z.string()).optional()
        })),
        currency: z.boolean().optional().describe("Formats numeric labels as INR currency")
      })).describe("1 to 4 structured data plots")
    },
    async ({ title, summary, kpis = [], charts = [] }) => {
      try {
        const PALETTE = ["#6366F1", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#3B82F6", "#6B7280"];
        const content = [];

        // 1. Textual Dashboard & KPI Card Generator
        if (kpis.length || summary) {
          let txt = `### 📊 ${title}\n\n`;
          if (summary) txt += `> **Insight Analysis:** ${summary}\n\n`;
          if (kpis.length) {
            txt += `| ${kpis.map(k => k.label).join(" | ")} |\n`;
            txt += `|${kpis.map(() => "---").join("|")}|\n`;
            txt += `| ${kpis.map(k => `**${k.value}**${k.trend ? ` (\`${k.trend}\`)` : ""}`).join(" | ")} |\n`;
          }
          content.push({ type: "text", text: txt });
        }

        // 2. High-Fidelity Chart Composer (QuickChart Engine)
        const chartPromises = charts.slice(0, 4).map(async (ch) => {
          const isH = ch.type === "horizontalBar";
          const isRound = ch.type === "doughnut" || ch.type === "pie";
          
          const datasets = ch.datasets.map((d, di) => ({
            label: d.label || "",
            data: d.data,
            backgroundColor: d.colors || (isRound || isH 
              ? ch.labels.map((_, i) => PALETTE[i % PALETTE.length]) 
              : PALETTE[di % PALETTE.length]),
            borderWidth: isRound ? 0 : 1.5,
            borderColor: d.color || PALETTE[di % PALETTE.length],
            borderRadius: isRound ? 0 : 5,
            tension: 0.35 // Smooth bezier curves for line charts
          }));

          const currencyFormatter = "function(v){return v>=1e5?'\\u20B9'+(v/1e5).toFixed(1)+'L':v>=1e3?'\\u20B9'+(v/1e3).toFixed(0)+'K':'\\u20B9'+Math.round(v)}";

          const chartJsConfig = {
            type: isH ? "bar" : ch.type,
            data: { labels: ch.labels, datasets },
            options: {
              ...(isH ? { indexAxis: "y" } : {}),
              plugins: {
                title: {
                  display: true,
                  text: ch.title,
                  font: { size: 14, weight: "bold", family: "'Helvetica Neue', 'Arial'" },
                  color: "#1F2937"
                },
                legend: {
                  display: isRound,
                  position: "right",
                  labels: { boxWidth: 12, font: { size: 11 } }
                },
                datalabels: { display: false }
              },
              ...(isRound ? {} : {
                scales: {
                  [isH ? "x" : "y"]: {
                    grid: { color: "#F3F4F6" },
                    ticks: {
                      font: { size: 10 },
                      callback: ch.currency ? currencyFormatter : undefined
                    }
                  },
                  [isH ? "y" : "x"]: {
                    grid: { display: false },
                    ticks: { font: { size: 10 } }
                  }
                }
              })
            }
          };

          // Dispatch async HTTP request to high-speed global render engine
          const resp = await axios.post(
            "https://quickchart.io/chart",
            {
              chart: chartJsConfig,
              width: 580,
              height: isRound ? 280 : 320,
              backgroundColor: "#FFFFFF",
              format: "png"
            },
            { responseType: "arraybuffer", timeout: 2500 } // Ultra-fast timeout fallback
          );
          return { mime: "image/png", data: Buffer.from(resp.data).toString("base64") };
        });

        try {
          const pngs = await Promise.all(chartPromises);
          pngs.forEach(img => {
            content.push({ type: "image", data: img.data, mimeType: img.mime });
          });
        } catch (netErr) {
          console.warn("⚠️ QuickChart render failed or offline. Resorting to native SVG drawer:", netErr.message);
          // PERFECT OFFLINE FALLBACK: Invoke our direct SVG generator if the internet dies
          const svg = buildChartSVG(title, summary, kpis, charts);
          content.push({
            type: "image",
            data: Buffer.from(svg).toString("base64"),
            mimeType: "image/svg+xml"
          });
        }

        return { content };
      } catch (globalErr) {
        return err(globalErr);
      }
    }
  );

  // ── FULL REPORT DASHBOARD ───────────────────────────────────────────────────
  server.tool(
    "get_dashboard",
    "Exclusively for full 'overview', 'dashboard', or 'report' requests. Delivers the interactive Chart.js UI.",
    {
      from_date: z.string().describe("YYYY-MM-DD"),
      to_date: z.string().describe("YYYY-MM-DD"),
    },
    async ({ from_date, to_date }) => {
      try {
        const html = await getDashboard(from_date, to_date);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `urn:lovelypets:dashboard:${Date.now()}`,
                mimeType: "text/html",
                text: html,
              },
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );

  // ── GOD-LEVEL WAREHOUSE DIRECTORY LOOKUP ────────────────────────────────────
  server.tool(
    "search_directory",
    "Performs lightning-fast, immediate full-text search across 30,000+ synthetic warehouse records to find clients or patients by name or phone.",
    {
      query: z.string().describe("Name fragment, email, or contact number phrase to locate")
    },
    async ({ query }) => {
      try {
        const match = `%${query}%`;
        
        const clients = await db.query(
          `SELECT client_id, first_name, last_name, clinic_name, email, mobile_phone, status 
           FROM lovely_clients 
           WHERE first_name LIKE ? OR last_name LIKE ? OR mobile_phone LIKE ? OR email LIKE ? LIMIT 20`,
          [match, match, match, match]
        );

        const patients = await db.query(
          `SELECT patient_id, patient_name, client_id, species, breed, gender, status 
           FROM lovely_patients 
           WHERE patient_name LIKE ? OR breed LIKE ? LIMIT 20`,
          [match, match]
        );

        return ok({
          matched_clients: clients,
          matched_patients: patients,
          summary: `Query retrieved ${clients.length} matching clients and ${patients.length} matching patients from RDS.`
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  // ── GOD-LEVEL ELECTRONIC MEDICAL RECORD VIEWER ─────────────────────────────
  server.tool(
    "get_patient_card",
    "Generates an instantaneous, 360-degree clinical dossier for any specific patient, including demographical data, recent appointments, and lab diagnostics.",
    {
      patient_id: z.string().describe("Unique relational patient ID, e.g., 'PA-101_S4'")
    },
    async ({ patient_id }) => {
      try {
        // 1. Pull foundational demographic facts
        const core = await db.query(`SELECT * FROM lovely_patients WHERE patient_id = ?`, [patient_id]);
        if (!core.length) return err(`Could not find patient with ID ${patient_id} in the scaled RDS.`);

        // 2. Fetch past visit history
        const visits = await db.query(
          `SELECT appointment_start_time as visit_date, appointment_status as status, appointment_type_name as type, reason_for_visit 
           FROM lovely_appointments 
           WHERE patient_id = ? 
           ORDER BY appointment_start_time DESC LIMIT 8`,
          [patient_id]
        );

        // 3. Retrieve lab & clinical reports
        const labs = await db.query(
          `SELECT report_date, plan_item_name as medical_service, plan_category_name as category, provider_name, status 
           FROM lovely_patient_diagnosis 
           WHERE patient_id = ? 
           ORDER BY report_date DESC LIMIT 8`,
          [patient_id]
        );

        return ok({
          patient_demographics: core[0],
          historical_visits: visits,
          clinical_diagnostics: labs
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  // ── GOD-LEVEL INVENTORY CAPITAL ENGINE ──────────────────────────────────────
  server.tool(
    "get_stock_intelligence",
    "Audits the warehouse inventory, extracting immediate financial stats (locked capital) and prioritizing critical item replenishments.",
    {},
    async () => {
      try {
        // Aggregation of inventory valuations grouped by health
        const aggregates = await db.query(`
          SELECT 
            stock_status,
            COUNT(*) as sku_count,
            ROUND(SUM(onhand_qty), 0) as total_physical_units,
            ROUND(SUM(onhand_qty * purchase_cost), 2) as total_capital_value_inr
          FROM lovely_stock
          GROUP BY stock_status
          ORDER BY total_capital_value_inr DESC
        `);

        // Sift out top critical alerts
        const alerts = await db.query(`
          SELECT stock_name, clinic_name, onhand_qty, threshold_qty, purchase_cost, stock_status 
          FROM lovely_stock 
          WHERE stock_status IN ('negative', 'out', 'low')
          ORDER BY stock_status ASC, (purchase_cost * onhand_qty) DESC
          LIMIT 35
        `);

        return ok({
          capital_valuation_by_status: aggregates,
          critical_stock_alerts: alerts,
          action_advice: "Inspect critical stock alerts immediately to release negative holdings and purchase deficit units."
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  // ── GOD-LEVEL BUSINESS PULSE RADAR ──────────────────────────────────────────
  server.tool(
    "get_business_pulse",
    "Aggregates group-wide transactional performance, delivering Gross/Net cash, Average Order Value (AOV), and client acquisition summaries.",
    {
      from_date: z.string().describe("YYYY-MM-DD range start"),
      to_date: z.string().describe("YYYY-MM-DD range end")
    },
    async ({ from_date, to_date }) => {
      try {
        // Combined operational aggregation
        const rev = await db.query(`
          SELECT 
            COUNT(invoice_id) as count_invoices,
            COALESCE(SUM(CASE WHEN is_new_client=1 THEN 1 ELSE 0 END), 0) as count_new_clients,
            ROUND(COALESCE(SUM(invoice_amount), 0), 2) as gross_revenue_inr,
            ROUND(COALESCE(AVG(invoice_amount), 0), 2) as average_invoice_basket_inr
          FROM lovely_invoices 
          WHERE cancelled = 0 AND DATE(invoice_date) BETWEEN ? AND ?`,
          [from_date, to_date]
        );

        const pmts = await db.query(`
          SELECT ROUND(COALESCE(SUM(payment_amount), 0), 2) as total_collected_cash_inr
          FROM lovely_payments 
          WHERE returned = 0 AND DATE(payment_date) BETWEEN ? AND ?`,
          [from_date, to_date]
        );

        const conversion = await db.query(`
          SELECT appointment_status, COUNT(*) as totals 
          FROM lovely_appointments
          WHERE DATE(appointment_start_time) BETWEEN ? AND ?
          GROUP BY appointment_status`,
          [from_date, to_date]
        );

        return ok({
          finance_overview: {
            invoiced_revenue: rev[0].gross_revenue_inr,
            collected_cash: pmts[0].total_collected_cash_inr,
            invoice_volume: rev[0].count_invoices,
            average_basket_aov: rev[0].average_invoice_basket_inr
          },
          acquisitions: {
            new_clients_joined: rev[0].count_new_clients
          },
          appointments_funnel: conversion
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  return server;
}

// ── SSE LISTENERS ─────────────────────────────────────────────────────────────
app.get("/mcp", async (req, res) => {
  console.log("[SSE] Lovely Pets client connecting to /mcp...");
  const transport = new SSEServerTransport("/messages", res);
  activeTransports.set(transport.sessionId, transport);

  res.on("close", () => {
    activeTransports.delete(transport.sessionId);
  });

  const mcpServer = buildMcpServer();
  try {
    await mcpServer.connect(transport);
  } catch (e) {
    console.error("[SSE] Handshake failed:", e);
  }
});

app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  const transport = activeTransports.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found." });
  
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (e) {
    console.error("[SSE] Handle error:", e);
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n✨ LOVELY PETS INTELLIGENCE MCP ONLINE ✨`);
  console.log(`🚀 Server running on: http://localhost:${PORT}`);
  console.log(`🔗 MCP URL for Claude: http://localhost:${PORT}/mcp\n`);
});
