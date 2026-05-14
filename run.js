require("dotenv").config();
const bootstrap = require("./bootstrap.js");
const generator = require("./generator.js");
const { pool } = require("./db.js");

async function main() {
  console.log("================================================");
  console.log("🐾 LOVELY PETS DATA REPLICATOR & SCALER INIT 🐾");
  console.log("================================================");
  console.log(`🌍 RDS Host: ${process.env.DB_HOST}`);
  console.log(`🗄️  Database Name: ${process.env.DB_NAME}`);
  console.log("================================================");

  // 1. Bootstrap the new DB and Tables
  const bootOk = await bootstrap();
  if (!bootOk) {
    console.error("\n❌ Could not complete database bootstrap. Aborting generator.");
    process.exit(1);
  }

  console.log("\n⏳ Database ready. Initializing API replication pipeline in 3s...");
  await new Promise(r => setTimeout(r, 3000));

  // 2. Run the Generator logic to fetch and replicate data
  try {
    await generator();
  } catch (err) {
    console.error("\n❌ Data replication failed:", err);
    process.exit(1);
  } finally {
    // Close database connection safely
    await pool.end();
    console.log("\n🏁 Replicator finished execution and connections closed.");
  }
}

main();
