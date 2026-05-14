/**
 * get_exact_counts.js
 * ──────────────────
 * Probes the VetBuddy Open API endpoints across all-time,
 * calculates total record counts via intelligent two-step metadata probing,
 * and outputs an elegant console report.
 */

require("dotenv").config();
const axios = require("axios");

const BASE = process.env.VETBUDDY_APP_URL;
const UID = process.env.VETBUDDY_UID;
const PASSWD = process.env.VETBUDDY_PASSWD;

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function getExactCounts() {
  console.log("\n================================================");
  console.log("📊 VETBUDDY API ALL-TIME EXACT RECORD PROBER ");
  console.log("================================================\n");

  console.log("🔑 Authorizing and fetching API session token...");
  let token;
  try {
    const tokRes = await axios.get(`${BASE}/openapi.php`, {
      params: { action: "get_token", uid: UID, passwd: PASSWD },
      headers: { Accept: "application/json" },
      timeout: 10000,
    });
    token = tokRes.data.Token;
    console.log("✅ Token retrieved successfully.\n");
  } catch (err) {
    console.error("❌ Fatal: Could not authenticate with VetBuddy API:", err.message);
    return;
  }

  const endpoints = [
    { name: "Clients", action: "clients", params: {} },
    { name: "Patients", action: "patients", params: {} },
    { name: "Appointments", action: "appointment", params: { startdate: "01/01/2010", enddate: "12/31/2035" } },
    { name: "Invoices", action: "invoice", params: { startdate: "01/01/2010", enddate: "12/31/2035" } },
    { name: "Payments", action: "payment", params: { startpaymentdate: "01/01/2010", endpaymentdate: "12/31/2035" } },
    { name: "Stock SKUs", action: "stock", params: {} },
    { name: "Staff Members", action: "staff", params: {} },
    { name: "Clinics", action: "clinic", params: {} }
  ];

  const tableData = [];
  const PAGESIZE = 100;

  for (const ep of endpoints) {
    process.stdout.write(`📡 Probing [${ep.name}]... `);
    try {
      // Phase 1: Fetch the first page to determine total pages and meta data
      const res1 = await axios.get(`${BASE}/openapi.php`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        params: { ...ep.params, action: ep.action, page: 1, pagesize: PAGESIZE }
      });

      let totalPages = 0;
      let firstPageCount = 0;
      let directTotal = null;

      if (res1.data && typeof res1.data === "object") {
        for (const key of Object.keys(res1.data)) {
          const sec = res1.data[key];
          const meta = sec?.["@attributes"];
          if (meta) {
            totalPages = parseInt(meta.total_pages || "0", 10);
            // API could sometimes supply total_records or total directly in attributes:
            if (meta.total_records) directTotal = parseInt(meta.total_records, 10);
            else if (meta.total) directTotal = parseInt(meta.total, 10);
            
            const dataKey = Object.keys(sec).find(k => k !== "@attributes");
            firstPageCount = toArray(sec[dataKey]).length;
            break;
          }
        }
      }

      let exactTotal = 0;

      // Phase 2: Calculate the exact count
      if (directTotal !== null) {
        // Case A: API gives the total directly! Perfect!
        exactTotal = directTotal;
      } else if (totalPages <= 1) {
        // Case B: Under 1 page of results
        exactTotal = firstPageCount;
      } else {
        // Case C: Multiple pages. Fetch the final page to count tail items exactly.
        const resTail = await axios.get(`${BASE}/openapi.php`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          params: { ...ep.params, action: ep.action, page: totalPages, pagesize: PAGESIZE }
        });

        let tailCount = 0;
        if (resTail.data && typeof resTail.data === "object") {
          for (const key of Object.keys(resTail.data)) {
            const sec = resTail.data[key];
            const dataKey = Object.keys(sec).find(k => k !== "@attributes");
            tailCount = toArray(sec[dataKey]).length;
            break;
          }
        }

        exactTotal = ((totalPages - 1) * PAGESIZE) + tailCount;
      }

      console.log(`SUCCESS! Found ${exactTotal.toLocaleString()}`);
      tableData.push({
        "API Entity": ep.name,
        "Total Count (All-Time)": exactTotal.toLocaleString(),
        "Pages": totalPages
      });

    } catch (e) {
      console.log(`FAILED (${e.message})`);
      tableData.push({
        "API Entity": ep.name,
        "Total Count (All-Time)": "Error Probing",
        "Pages": "-"
      });
    }
  }

  console.log("\n================================================");
  console.log("📈 LIVE VETBUDDY API HISTORICAL TOTALS");
  console.log("================================================\n");
  console.table(tableData);
  console.log("\n================================================\n");
}

getExactCounts();
