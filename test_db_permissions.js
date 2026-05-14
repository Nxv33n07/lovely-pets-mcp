require("dotenv").config();
const mysql = require("mysql2/promise");

async function checkCapabilities() {
  console.log("🔍 Connecting to RDS Host:", process.env.DB_HOST);
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    // We don't specify a database here to connect globally
  });

  try {
    // 1. List existing databases
    console.log("\n📋 Checking existing databases:");
    const [dbRows] = await pool.query("SHOW DATABASES");
    const dbNames = dbRows.map(r => r.Database);
    console.log(dbNames);

    // 2. Try creating a database
    const testDbName = "cohort_lovely_pets";
    console.log(`\n🧪 Attempting to create database '${testDbName}'...`);
    
    try {
      await pool.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\``);
      console.log(`✅ SUCCESS! Created (or confirmed existence of) database: ${testDbName}`);
    } catch (createErr) {
      console.log(`❌ FAILED to create '${testDbName}':`, createErr.message);
      
      // Try without the prefix just in case
      const testDbName2 = "lovely_pets";
      console.log(`🧪 Retrying with database name '${testDbName2}'...`);
      try {
        await pool.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName2}\``);
        console.log(`✅ SUCCESS! Created (or confirmed existence of) database: ${testDbName2}`);
      } catch (err2) {
        console.log(`❌ FAILED to create '${testDbName2}':`, err2.message);
      }
    }

  } catch (err) {
    console.error("❌ Connection/Execution failed:", err.message);
  } finally {
    await pool.end();
  }
}

checkCapabilities();
