require("dotenv").config();
const vb = require("./vetbuddy.js");
const { pool, query, getStdCat } = require("./db.js");

// ── Scaling Configuration ──────────────────────────────────────────────────────
const SCALING_FACTOR = parseInt(process.env.SCALING_FACTOR || "10", 10);
const TRANSACTION_SCALING_FACTOR = 60; // Multiplier for dense transactional history
const FETCH_DAYS = parseInt(process.env.FETCH_DAYS || "45", 10); // Default to 45 days of real data

console.log(`🌟 Scaling Factor: ${SCALING_FACTOR}x (Entities), ${TRANSACTION_SCALING_FACTOR}x (Transactions)`);
console.log(`📅 Fetching actual data from past ${FETCH_DAYS} days to use as template...`);

// ── Utilities ─────────────────────────────────────────────────────────────────
function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function getSpeciesGroup(sp) {
  const s = (sp || "").trim();
  if (s === "Canine") return "Canine";
  if (s === "Feline") return "Feline";
  return "Others";
}

// "MM/DD/YYYY HH:MM:SS" → "YYYY-MM-DD HH:MM:SS"
function toMysqlDt(s) {
  if (!s) return null;
  const parts = s.trim().split(" ");
  const [m, d, y] = parts[0].split("/");
  if (!y) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")} ${parts[1] || "00:00:00"}`;
}

function parseHour(s) {
  if (!s || !s.includes(" ")) return 9;
  const h = parseInt((s.split(" ")[1] || "00").split(":")[0], 10);
  return isNaN(h) ? 9 : h;
}

function toVBDate(dateObj) {
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  const y = dateObj.getFullYear();
  return `${m}/${d}/${y}`;
}

// Variance helper: adjusts a number by +/- N%
function addVariance(val, pctRange = 15) {
  const mult = 1 + (Math.random() * 2 - 1) * (pctRange / 100);
  return Math.max(0, +(val * mult).toFixed(2));
}

// Date offset helper: shifts a MySQL datetime string by random days/hours
function shiftDate(mysqlDtStr, maxDaysBack = 60) {
  if (!mysqlDtStr) return null;
  const d = new Date(mysqlDtStr.replace(" ", "T"));
  if (isNaN(d.getTime())) return mysqlDtStr;

  // Shift random days back, and random minutes to distribute
  const randomDays = Math.floor(Math.random() * maxDaysBack);
  const randomMs = Math.floor(Math.random() * 24 * 60 * 60 * 1000);

  const shifted = new Date(d.getTime() - (randomDays * 24 * 60 * 60 * 1000) - randomMs);

  // Format back to YYYY-MM-DD HH:MM:SS
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())} ${pad(shifted.getHours())}:${pad(shifted.getMinutes())}:${pad(shifted.getSeconds())}`;
}

// Helper to insert rows in high-performance chunks to RDS to prevent sequential connection lag
async function runBatchInsert(tableName, columns, dataRows, updateClause) {
  if (!dataRows || dataRows.length === 0) return;
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < dataRows.length; i += CHUNK_SIZE) {
    const chunk = dataRows.slice(i, i + CHUNK_SIZE);
    const colStr = columns.map(c => `\`${c}\``).join(", ");
    const sql = `INSERT INTO \`${tableName}\` (${colStr}) VALUES ? ${updateClause}`;
    await pool.query(sql, [chunk]);
  }
}

// ── Scaling Replication Logic ────────────────────────────────────────────────
async function processAndScaleData() {
  let stockCount = 0;
  let dxCount = 0;

  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - FETCH_DAYS);

  const fromStr = toVBDate(pastDate);
  const toStr = toVBDate(today);

  console.log(`\n📡 1. Pulling reference data from VetBuddy Open API (${fromStr} to ${toStr})...`);

  // 1.1 Clinics & Staff (Static data)
  let sourceClinics = [];
  let sourceStaff = [];
  try {
    sourceClinics = await vb.getClinics();
    sourceStaff = await vb.getStaff({ max_pages: 5 });
    console.log(`✅ Fetched ${sourceClinics.length} clinics and ${sourceStaff.length} staff members.`);
  } catch (e) {
    console.error("⚠️ Warning: Fetch static data failed:", e.message);
  }

  // 1.2 Relational/Transactional templates
  let sourceClients = [];
  try {
    sourceClients = await vb.getClients({ max_pages: 15 });
    console.log(`✅ Fetched ${sourceClients.length} source clients.`);
  } catch (e) { console.error("⚠️ Clients error:", e.message); }

  let sourcePatients = [];
  try {
    sourcePatients = await vb.getPatients({ max_pages: 15 });
    console.log(`✅ Fetched ${sourcePatients.length} source patients.`);
  } catch (e) { console.error("⚠️ Patients error:", e.message); }

  // Build Client -> Patient index for intelligent relational shuffling
  const clientPatientsMap = new Map();
  for (const p of sourcePatients) {
    const cId = p.Client?.ClientID || "WALKIN";
    if (!clientPatientsMap.has(cId)) clientPatientsMap.set(cId, []);
    clientPatientsMap.get(cId).push(p.PatientId || p.PatientID);
  }

  let sourceAppointments = [];
  try {
    sourceAppointments = await vb.getAppointments({ startdate: fromStr, enddate: toStr, max_pages: 6 });
    console.log(`✅ Fetched ${sourceAppointments.length} source appointments.`);
  } catch (e) { console.error("⚠️ Appointments error:", e.message); }

  let sourceInvoices = [];
  try {
    sourceInvoices = await vb.getInvoices({
      startdate: fromStr,
      enddate: toStr,
      max_pages: 6
    });
    console.log(`✅ Fetched ${sourceInvoices.length} source invoices.`);
  } catch (e) {
    console.error("❌ Error fetching invoices:", e.message);
    return;
  }

  let sourcePayments = [];
  try {
    sourcePayments = await vb.getPayments({
      startpaymentdate: fromStr,
      endpaymentdate: toStr,
      max_pages: 6
    });
    console.log(`✅ Fetched ${sourcePayments.length} source payments.`);
  } catch (e) {
    console.error("❌ Error fetching payments:", e.message);
  }

  console.log("\n🚜 2. Replicating and Generating Scaled Dummy Records...");

  // A. Replicate Static Entities (Clinics & Staff)
  const clinicRows = [];
  for (const cl of sourceClinics) {
    const cid = cl.ClinicID;
    if (cid) clinicRows.push([cid, cl.ClinicName || "Clinic Name"]);
  }
  await runBatchInsert(
    "lovely_clinics",
    ["clinic_id", "clinic_name"],
    clinicRows,
    "ON DUPLICATE KEY UPDATE clinic_name = VALUES(clinic_name)"
  );

  const staffRows = [];
  for (const st of sourceStaff) {
    const sid = st.StaffID;
    if (sid) staffRows.push([sid, st.StaffName || "Staff Member", st.Designation || "Veterinarian"]);
  }
  await runBatchInsert(
    "lovely_staff",
    ["staff_id", "staff_name", "role"],
    staffRows,
    "ON DUPLICATE KEY UPDATE staff_name = VALUES(staff_name), role = VALUES(role)"
  );
  console.log("✅ Static metadata (Clinics/Staff) written.");

  // B. Scale Clients
  const clientRows = [];
  for (const client of sourceClients) {
    const realCid = client.ClientID;
    if (!realCid) continue;
    for (let sIdx = 0; sIdx < SCALING_FACTOR; sIdx++) {
      const scaleId = `S${sIdx}`;
      const dummyCid = `${realCid}_${scaleId}`;
      clientRows.push([
        dummyCid,
        sIdx === 0 ? client.FirstName : `${client.FirstName || "Client"}_${sIdx}`,
        client.LastName || "",
        client.Clinic?.ClinicName || "Lovely Pets Clinic",
        client.Email || null,
        client.MobilePhone || null,
        client.City || null,
        client.Status || "Active"
      ]);
    }
  }
  await runBatchInsert(
    "lovely_clients",
    ["client_id", "first_name", "last_name", "clinic_name", "email", "mobile_phone", "city", "status"],
    clientRows,
    "ON DUPLICATE KEY UPDATE status = VALUES(status)"
  );
  const clientInserts = clientRows.length;
  console.log(`✅ Client replication done! Generated: ${clientInserts}`);

  // C. Scale Patients
  const patientRows = [];
  for (const pat of sourcePatients) {
    const realPid = pat.PatientId || pat.PatientID;
    if (!realPid) continue;
    const realCid = pat.Client?.ClientID || "WALKIN";

    for (let sIdx = 0; sIdx < SCALING_FACTOR; sIdx++) {
      const scaleId = `S${sIdx}`;
      const dummyPid = `${realPid}_${scaleId}`;
      const dummyCid = `${realCid}_${scaleId}`;
      patientRows.push([
        dummyPid,
        sIdx === 0 ? pat.PatientName : `${pat.PatientName || "Pet"}_${sIdx}`,
        dummyCid,
        pat.BirthDate || null,
        pat.PatientSpecies || pat.Species?.SpeciesName || "Others",
        pat.PatientBreed || pat.Breed?.BreedName || "Mixed",
        pat.Gender || "Unknown",
        pat.Neutered || "FALSE",
        pat.Status || "Active"
      ]);
    }
  }
  await runBatchInsert(
    "lovely_patients",
    ["patient_id", "patient_name", "client_id", "birth_date", "species", "breed", "gender", "neutered", "status"],
    patientRows,
    "ON DUPLICATE KEY UPDATE status = VALUES(status)"
  );
  const patientInserts = patientRows.length;
  console.log(`✅ Patient replication done! Generated: ${patientInserts}`);

  // D. Scale Appointments
  const apptRows = [];
  for (const appt of sourceAppointments) {
    const realAid = appt.AppointmentID;
    if (!realAid) continue;
    const realCid = appt.Client?.ClientID || "WALKIN";
    const realPid = appt.Patient?.PatientID || "UNKNOWN";

    const startStr = toMysqlDt(appt.AppointmentStartTime || appt.AppointmentTime);
    const endStr = toMysqlDt(appt.AppointmentEndTime);
    if (!startStr) continue;

    for (let sIdx = 0; sIdx < TRANSACTION_SCALING_FACTOR; sIdx++) {
      const scaleId = `S${sIdx}`;
      const dummyAid = `${realAid}_${scaleId}`;

      // Map synthetic transactions safely to the 15,000 existing entities to maintain relational integrity
      const targetEntIdx = sIdx < SCALING_FACTOR ? sIdx : Math.floor(Math.random() * SCALING_FACTOR);
      const dummyCid = `${realCid}_S${targetEntIdx}`;
      const dummyPid = `${realPid}_S${targetEntIdx}`;

      // Scatter scaled logs across 240 days to deliver superb multi-month analytical trendlines
      const dayOffset = sIdx === 0 ? 0 : Math.floor(Math.random() * 240) - 120;
      const shiftedStart = sIdx === 0 ? startStr : shiftDate(startStr, dayOffset);
      const shiftedEnd = sIdx === 0 ? endStr : shiftDate(endStr || startStr, dayOffset);

      apptRows.push([
        dummyAid,
        dummyCid,
        dummyPid,
        appt.Clinic?.ClinicName || "Lovely Pets Clinic",
        shiftedStart,
        shiftedEnd,
        appt.AppointmentStatus || "Pending",
        appt.AppointmentType?.AppointmentTypeName || "Consultation",
        appt.ReasonForVisit || null,
        appt.Staff?.StaffID || null
      ]);
    }
  }
  await runBatchInsert(
    "lovely_appointments",
    ["appointment_id", "client_id", "patient_id", "clinic_name", "appointment_start_time", "appointment_end_time", "appointment_status", "appointment_type_name", "reason_for_visit", "staff_id"],
    apptRows,
    "ON DUPLICATE KEY UPDATE appointment_status = VALUES(appointment_status)"
  );
  const apptInserts = apptRows.length;
  console.log(`✅ Appointment replication done! Generated: ${apptInserts}`);

  // Keep track of simulated generated mappings
  const invoiceIdMap = new Map(); // Maps real invoice ID -> [generated scaled IDs]

  // E. Scale and insert Invoices & Invoice Items
  console.log(`🔨 Replicating Invoices with Factor = ${SCALING_FACTOR}x...`);
  const invoiceRows = [];
  const invoiceItemRows = [];

  for (const inv of sourceInvoices) {
    const realInvoiceId = inv.InvoiceDetails?.InvoiceId;
    if (!realInvoiceId) continue;

    const realClientId = inv.Client?.ClientID || "WALKIN";
    const realDate = inv.InvoiceDetails?.InvoiceDate || "";
    const baseMysqlDt = toMysqlDt(realDate);
    if (!baseMysqlDt) continue;

    const baseAmount = safeNum(inv.InvoiceDetails?.InvoiceAmount);
    const isCancelled = (inv.InvoiceDetails?.Cancelled || "").toUpperCase() === "TRUE" ? 1 : 0;

    // For each invoice, generate N scaled versions
    for (let scaleIdx = 0; scaleIdx < TRANSACTION_SCALING_FACTOR; scaleIdx++) {
      const isPrimaryOriginal = (scaleIdx === 0);

      const scaleId = `S${scaleIdx}`;
      const dummyInvoiceId = `${realInvoiceId}_${scaleId}`;

      // INTELLIGENT VARIANCE: Assign random source clients for synthetic scales
      let assignedRealClientId = realClientId;
      if (scaleIdx > 0 && sourceClients.length > 0) {
        const randClient = sourceClients[Math.floor(Math.random() * sourceClients.length)];
        assignedRealClientId = randClient.ClientID || realClientId;
      }

      // Map safely into our established entity pool
      const targetEntIdx = scaleIdx < SCALING_FACTOR ? scaleIdx : Math.floor(Math.random() * SCALING_FACTOR);
      const dummyClientId = `${assignedRealClientId}_S${targetEntIdx}`;

      const scaledAmount = isPrimaryOriginal ? baseAmount : addVariance(baseAmount, 15);
      
      // Scatter dates elegantly across the 240 day history for detailed AI analytics!
      const dayOffset = isPrimaryOriginal ? 0 : Math.floor(Math.random() * 240) - 120;
      const scaledMysqlDate = isPrimaryOriginal ? baseMysqlDt : shiftDate(baseMysqlDt, dayOffset);

      const hour = parseInt((scaledMysqlDate.split(" ")[1] || "00").split(":")[0], 10);
      const shift = hour >= 9 && hour < 21 ? "Day" : "Night";

      const isNew = Math.random() < 0.2 ? 1 : 0;

      invoiceRows.push([
        dummyInvoiceId,
        scaledMysqlDate,
        scaledAmount,
        shift,
        isCancelled,
        isNew,
        dummyClientId
      ]);

      // Track mapping for payment associations
      if (!invoiceIdMap.has(realInvoiceId)) invoiceIdMap.set(realInvoiceId, []);
      invoiceIdMap.get(realInvoiceId).push({
        dummyInvoiceId,
        dummyClientId,
        scaledMysqlDate,
        varianceRatio: scaledAmount / (baseAmount || 1)
      });

      // Replicate Invoice Items
      const patArr = toArray(inv.Patients?.Patient);
      for (const pat of patArr) {
        let assignedRealPatientId = pat.PatientId || "UNKNOWN";

        // Select an authentic patient of the currently assigned shuffled client
        if (scaleIdx > 0 && clientPatientsMap.has(assignedRealClientId)) {
          const clientPats = clientPatientsMap.get(assignedRealClientId);
          if (clientPats.length > 0) {
            assignedRealPatientId = clientPats[Math.floor(Math.random() * clientPats.length)];
          }
        }
        const dummyPatientId = `${assignedRealPatientId}_S${targetEntIdx}`;

        const speciesStr = getSpeciesGroup(pat.PatientSpecies || pat.Species?.SpeciesName);

        // SHUFFLE / REORDER items to generate maximum diversity as requested!
        const itemArr = toArray(pat.Items?.Item);
        const shuffledItems = isPrimaryOriginal ? itemArr : [...itemArr].sort(() => Math.random() - 0.5);

        for (const item of shuffledItems) {
          const realSalesId = item.SalesID || item.ItemID || "0";
          const dummySalesId = `${realSalesId}_${scaleId}`;

          const realItemAmt = safeNum(item.Total || item.ItemAmount);
          const scaledItemAmt = +(realItemAmt * (scaledAmount / (baseAmount || 1))).toFixed(2);

          const rawCat = item.PlanItem?.PlanCategory?.PlanCategoryName || "";
          const subCat = item.PlanItem?.PlanSubCategory?.PlanSubCategoryName || null;
          const stdCat = getStdCat(rawCat);

          invoiceItemRows.push([
            dummyInvoiceId,
            scaledMysqlDate,
            scaledItemAmt,
            speciesStr,
            stdCat,
            subCat,
            dummySalesId,
            dummyPatientId
          ]);
        }
      }
    }
  }

  await runBatchInsert(
    "lovely_invoices",
    ["invoice_id", "invoice_date", "invoice_amount", "shift", "cancelled", "is_new_client", "client_id"],
    invoiceRows,
    "ON DUPLICATE KEY UPDATE invoice_amount = VALUES(invoice_amount), invoice_date = VALUES(invoice_date)"
  );

  await runBatchInsert(
    "lovely_invoice_items",
    ["invoice_id", "invoice_date", "item_total", "species_group", "std_category", "plan_sub_category_name", "sales_id", "patient_id"],
    invoiceItemRows,
    "ON DUPLICATE KEY UPDATE item_total = VALUES(item_total), invoice_date = VALUES(invoice_date)"
  );

  const totalInvoicesInserted = invoiceRows.length;
  const totalItemsInserted = invoiceItemRows.length;
  console.log(`✅ Invoice replication done! Invoices Generated: ${totalInvoicesInserted}, Line Items Generated: ${totalItemsInserted}`);

  // F. Scale and insert Payments
  console.log(`🔨 Replicating Payments with Factor = ${SCALING_FACTOR}x...`);
  const paymentRows = [];

  for (const pay of sourcePayments) {
    const realPaymentId = pay.PaymentID;
    if (!realPaymentId) continue;

    const realPayInvoiceId = pay.Invoice?.InvoiceID;
    const realPayClientId = pay.Client?.ClientID;

    const realDate = pay.PaymentDate || "";
    const baseMysqlPayDate = toMysqlDt(realDate);
    if (!baseMysqlPayDate) continue;

    const basePayAmount = safeNum(pay.PaymentAmount);
    const isReturned = (pay.Returned || "").toUpperCase() === "TRUE" ? 1 : 0;
    const payTypeName = pay.PaymentType?.PaymentTypeName || "Cash";
    const clinicId = pay.Clinic?.ClinicID || "1";

    for (let scaleIdx = 0; scaleIdx < TRANSACTION_SCALING_FACTOR; scaleIdx++) {
      const scaleId = `S${scaleIdx}`;
      const dummyPaymentId = `${realPaymentId}_${scaleId}`;

      let dummyInvoiceId = realPayInvoiceId ? `${realPayInvoiceId}_${scaleId}` : null;
      let dummyClientId = realPayClientId ? `${realPayClientId}_${scaleId}` : null;

      let varianceRatio = 1;
      let dummyPayDate = baseMysqlPayDate;

      // Resolve relational linkages seamlessly using the pre-built Invoice Mappings!
      if (realPayInvoiceId && invoiceIdMap.has(realPayInvoiceId)) {
        const mappings = invoiceIdMap.get(realPayInvoiceId);
        const match = mappings[scaleIdx];
        if (match) {
          dummyInvoiceId = match.dummyInvoiceId;
          dummyClientId = match.dummyClientId;
          varianceRatio = match.varianceRatio;
          dummyPayDate = match.scaledMysqlDate;
        }
      } else {
        // Fallback mapping for unlinked payments to keep relational keys valid
        const targetEntIdx = scaleIdx < SCALING_FACTOR ? scaleIdx : Math.floor(Math.random() * SCALING_FACTOR);
        dummyClientId = realPayClientId ? `${realPayClientId}_S${targetEntIdx}` : null;

        // Scatter dates across 240 days for unlinked payment events
        const dayOffset = scaleIdx === 0 ? 0 : Math.floor(Math.random() * 240) - 120;
        dummyPayDate = scaleIdx === 0 ? baseMysqlPayDate : shiftDate(baseMysqlPayDate, dayOffset);
        varianceRatio = scaleIdx === 0 ? 1 : (0.85 + Math.random() * 0.30);
      }

      const scaledPayAmount = +(basePayAmount * varianceRatio).toFixed(2);

      // Randomize payment types for synthetic records to produce superb AI analysis statistics!
      const randomPayType = scaleIdx === 0 ? payTypeName : ["Cash", "Credit Card", "Debit Card", "UPI", "Google Pay", "PhonePe", "Net Banking"][Math.floor(Math.random() * 7)];

      paymentRows.push([
        dummyPaymentId,
        dummyPayDate,
        scaledPayAmount,
        isReturned,
        dummyInvoiceId,
        dummyClientId,
        randomPayType,
        clinicId
      ]);
    }
  }

  await runBatchInsert(
    "lovely_payments",
    ["payment_id", "payment_date", "payment_amount", "returned", "invoice_id", "client_id", "payment_type_name", "clinic_id"],
    paymentRows,
    "ON DUPLICATE KEY UPDATE payment_amount = VALUES(payment_amount), payment_date = VALUES(payment_date)"
  );

  const totalPaymentsInserted = paymentRows.length;
  console.log(`✅ Payments replication done! Generated: ${totalPaymentsInserted}`);

  // G. Populate Stock Data
  console.log("\n📦 3. Replicating Stock Snapshot...");
  try {
    const stock = await vb.getStock({ max_pages: 5 });
    console.log(`Fetched ${stock.length} base stock items. Scaling them to populate dense simulated inventory...`);

    const stockRows = [];
    for (const s of stock) {
      const name = s.Stock?.StockName || s.StockName || null;
      const realStockId = s.Stock?.StockID || s.StockID || null;
      if (!name || !realStockId) continue;

      const clinicId = s.Clinic?.ClinicID || "1";
      const clinicName = s.Clinic?.ClinicName || "Lovely Pets Clinic";

      const oh = safeNum(s.OnhandQty);
      const th = safeNum(s.ThresholdQty);
      const cost = safeNum(s.PurchaseCost || s.Stock?.PlanItemDetails?.PlanItem?.CostPrice);
      const planCat = s.Stock?.PlanItemDetails?.PlanItem?.PlanCategory?.PlanCategoryName || null;
      const subCat = s.Stock?.PlanItemDetails?.PlanItem?.PlanSubCategory?.PlanSubCategoryName || null;

      for (let scaleIdx = 0; scaleIdx < SCALING_FACTOR; scaleIdx++) {
        const scaleId = `S${scaleIdx}`;
        const scaledStockId = `LP_${realStockId}_${scaleId}`;
        
        // Synthesize realistic variations in prices and quantities for separate inventory batches
        const syntheticCost = scaleIdx === 0 ? cost : +(cost * (0.8 + Math.random() * 0.4)).toFixed(2);
        const syntheticOh = Math.max(-5, Math.floor(oh * (0.2 + Math.random() * 1.8)));
        const syntheticName = scaleIdx === 0 ? `LP ${name}` : `LP ${name} (Lot-${scaleIdx + 1})`;

        let status = "adequate";
        if (syntheticOh < 0) status = "negative";
        else if (syntheticOh === 0) status = "out";
        else if (th > 0 && syntheticOh <= th) status = "low";

        stockRows.push([
          scaledStockId,
          clinicId,
          clinicName,
          syntheticName,
          planCat,
          subCat,
          getStdCat(planCat),
          syntheticOh,
          th,
          syntheticCost,
          status
        ]);
      }
    }

    await runBatchInsert(
      "lovely_stock",
      ["stock_id", "clinic_id", "clinic_name", "stock_name", "plan_category_name", "plan_sub_category_name", "std_category", "onhand_qty", "threshold_qty", "purchase_cost", "stock_status"],
      stockRows,
      "ON DUPLICATE KEY UPDATE onhand_qty = VALUES(onhand_qty), stock_status = VALUES(stock_status)"
    );

    stockCount = stockRows.length;
    console.log(`✅ Stock replication complete! Simulated: ${stockCount} SKUs.`);
  } catch (err) {
    console.error("⚠️ Stock replication failed:", err.message);
  }

  console.log("\n🧪 3.5 Replicating Patient Diagnosis Records...");
  try {
    const dxRows = [];
    // Fetch diagnosis records for the first 10 source clients to keep it efficient
    const clientsToFetch = sourceClients.slice(0, 10);
    for (const client of clientsToFetch) {
      const cid = client.ClientID;
      if (!cid) continue;

      const diagnosisRecords = await vb.getPatientDx({ clientid: cid });
      if (!diagnosisRecords || diagnosisRecords.length === 0) continue;

      for (const rec of diagnosisRecords) {
        const realLabReportId = rec.LabReportID;
        if (!realLabReportId) continue;

        const realPatId = rec.Patient?.PatientID || "UNKNOWN";
        const realClName = rec.Clinic?.ClinicName || "Lovely Pets Clinic";

        // Scale it relationally
        for (let sIdx = 0; sIdx < SCALING_FACTOR; sIdx++) {
          const scaleId = `S${sIdx}`;
          const dummyDxId = `${realLabReportId}_${scaleId}`;
          const dummyCid = `${cid}_${scaleId}`;
          const dummyPid = `${realPatId}_${scaleId}`;

          const rDate = toMysqlDt(rec.ReportDate);
          const shiftedDate = sIdx === 0 ? rDate : shiftDate(rDate, 90);

          dxRows.push([
            dummyDxId,
            rec.LabReportNo || null,
            rec.Clinic?.ClinicID || "1",
            realClName,
            dummyPid,
            rec.Patient?.PatientName || "Pet",
            dummyCid,
            rec.Item?.ItemName || null,
            rec.Item?.PlanCategory?.PlanCategoryName || null,
            shiftedDate,
            rec.Status || "Final",
            rec.Provider?.ProviderName || "Vet"
          ]);
        }
      }
    }

    await runBatchInsert(
      "lovely_patient_diagnosis",
      ["lab_report_id", "lab_report_no", "clinic_id", "clinic_name", "patient_id", "patient_name", "client_id", "plan_item_name", "plan_category_name", "report_date", "status", "provider_name"],
      dxRows,
      "ON DUPLICATE KEY UPDATE status = VALUES(status)"
    );

    dxCount = dxRows.length;
    console.log(`✅ Patient Diagnosis replication complete! Simulated: ${dxCount} lab records.`);
  } catch (err) {
    console.error("⚠️ Patient diagnosis replication skipped/failed:", err.message);
  }

  console.log("\n📈 4. Creating Execution Sync Log...");
  try {
    const logFmt = (d) => d.toISOString().slice(0, 10);
    await query(
      `INSERT INTO lovely_sync_log (sync_date, synced_at, status, records_count)
       VALUES (?, NOW(), 'success', ?)
       ON DUPLICATE KEY UPDATE synced_at = NOW(), records_count = VALUES(records_count)`,
      [logFmt(new Date()), totalInvoicesInserted + totalPaymentsInserted]
    );
    console.log("✅ Sync log created.");
  } catch (_) { }

  console.log("\n🎉 ALL REPLICATIONS COMPLETED SKELETON POPULATED SUCCESSFULLY!");
  console.log(`📊 Summary Generated:
   - Clients: ${clientInserts}
   - Patients: ${patientInserts}
   - Appointments: ${apptInserts}
   - Invoices: ${totalInvoicesInserted}
   - Invoice Items: ${totalItemsInserted}
   - Payments: ${totalPaymentsInserted}
   - Stock SKUs: ${stockCount}
   - Diagnosis Records: ${dxCount}`);
}

module.exports = processAndScaleData;

if (require.main === module) {
  processAndScaleData().catch(err => {
    console.error("\n❌ Scaler failed with fatal error:", err);
  }).finally(() => {
    pool.end();
  });
}
