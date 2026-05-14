require("dotenv").config();
const mysql = require("mysql2/promise");

const indexUpdates = [
  {
    table: 'lovely_invoice_items',
    name: 'idx_item_patient',
    sql: 'ALTER TABLE lovely_invoice_items ADD KEY idx_item_patient (patient_id)'
  },
  {
    table: 'lovely_payments',
    name: 'idx_pay_client',
    sql: 'ALTER TABLE lovely_payments ADD KEY idx_pay_client (client_id)'
  },
  {
    table: 'lovely_payments',
    name: 'idx_pay_invoice',
    sql: 'ALTER TABLE lovely_payments ADD KEY idx_pay_invoice (invoice_id)'
  }
];

async function applyIndexes() {
  console.log("🔍 Connecting to AWS RDS for performance index audit...");
  
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "3306"),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      connectTimeout: 10000
    });
    
    console.log("✅ Connected! Auditing table optimization indexes...");

    for (const task of indexUpdates) {
      try {
        process.stdout.write(` -> Applying index '${task.name}' on '${task.table}'... `);
        await connection.query(task.sql);
        console.log("SUCCESS ✅");
      } catch (err) {
        if (err.errno === 1061 || err.code === 'ER_DUP_KEYNAME') {
          console.log("ALREADY EXISTS (Safe) 🔔");
        } else {
          console.log(`FAILED ❌ (${err.message})`);
        }
      }
    }

    console.log("\n🎉 RDS Analytical Engine successfully supercharged for Claude!");
  } catch (err) {
    console.error("\n❌ Connection Error:", err.message);
    console.error("\n💡 Please ensure your computer is connected to the internet before running this script.");
  } finally {
    if (connection) await connection.end();
  }
}

applyIndexes();
