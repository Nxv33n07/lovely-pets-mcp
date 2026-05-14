require("dotenv").config();
const mysql = require("mysql2/promise");

const TABLES = {
  lovely_invoices: `
    CREATE TABLE IF NOT EXISTS \`lovely_invoices\` (
      \`invoice_id\`    VARCHAR(64)    NOT NULL,
      \`invoice_date\`  DATETIME       NOT NULL,
      \`invoice_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      \`shift\`         ENUM('Day','Night') NOT NULL DEFAULT 'Day',
      \`cancelled\`     TINYINT(1)     NOT NULL DEFAULT 0,
      \`is_new_client\` TINYINT(1)     NOT NULL DEFAULT 0,
      \`client_id\`     VARCHAR(64)    DEFAULT NULL,
      PRIMARY KEY (\`invoice_id\`),
      KEY \`idx_inv_date\`          (\`invoice_date\`),
      KEY \`idx_inv_cancelled_date\` (\`cancelled\`, \`invoice_date\`),
      KEY \`idx_inv_client\`        (\`client_id\`),
      KEY \`idx_inv_new_client\`    (\`is_new_client\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_invoice_items: `
    CREATE TABLE IF NOT EXISTS \`lovely_invoice_items\` (
      \`invoice_id\`             VARCHAR(64)  NOT NULL,
      \`invoice_date\`           DATETIME     NOT NULL,
      \`item_total\`             DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      \`species_group\`          ENUM('Canine','Feline','Others') NOT NULL DEFAULT 'Others',
      \`std_category\`           VARCHAR(64)  NOT NULL DEFAULT 'Others',
      \`plan_sub_category_name\` VARCHAR(255) DEFAULT NULL,
      \`sales_id\`               VARCHAR(64)  NOT NULL DEFAULT '',
      \`patient_id\`             VARCHAR(64)  NOT NULL DEFAULT '',
      UNIQUE KEY \`uk_item\`      (\`invoice_id\`, \`sales_id\`, \`patient_id\`),
      KEY \`idx_item_date\`       (\`invoice_date\`),
      KEY \`idx_item_species\`    (\`species_group\`, \`invoice_date\`),
      KEY \`idx_item_category\`   (\`std_category\`, \`invoice_date\`),
      KEY \`idx_item_patient\`    (\`patient_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_payments: `
    CREATE TABLE IF NOT EXISTS \`lovely_payments\` (
      \`payment_id\`        VARCHAR(64)   NOT NULL,
      \`clinic_id\`         VARCHAR(64)   DEFAULT NULL,
      \`client_id\`         VARCHAR(64)   DEFAULT NULL,
      \`invoice_id\`        VARCHAR(64)   DEFAULT NULL,
      \`payment_date\`      DATETIME      DEFAULT NULL,
      \`payment_amount\`    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      \`payment_type_name\` VARCHAR(64)   DEFAULT NULL,
      \`returned\`          TINYINT(1)    NOT NULL DEFAULT 0,
      PRIMARY KEY (\`payment_id\`),
      KEY \`idx_pay_date\`          (\`payment_date\`),
      KEY \`idx_pay_returned_date\` (\`returned\`, \`payment_date\`),
      KEY \`idx_pay_client\`        (\`client_id\`),
      KEY \`idx_pay_invoice\`       (\`invoice_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_stock: `
    CREATE TABLE IF NOT EXISTS \`lovely_stock\` (
      \`stock_id\`               VARCHAR(64)   NOT NULL,
      \`clinic_id\`              VARCHAR(64)   NOT NULL,
      \`clinic_name\`            VARCHAR(255)  DEFAULT NULL,
      \`stock_name\`             VARCHAR(255)  NOT NULL,
      \`plan_category_name\`     VARCHAR(128)  DEFAULT NULL,
      \`plan_sub_category_name\` VARCHAR(128)  DEFAULT NULL,
      \`std_category\`           VARCHAR(64)   DEFAULT NULL,
      \`onhand_qty\`             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`threshold_qty\`          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`purchase_cost\`          DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      \`stock_status\`           ENUM('adequate','low','out','negative') NOT NULL DEFAULT 'adequate',
      PRIMARY KEY (\`stock_id\`, \`clinic_id\`),
      KEY \`idx_stock_status\`   (\`stock_status\`),
      KEY \`idx_stock_std_cat\`  (\`std_category\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_sync_log: `
    CREATE TABLE IF NOT EXISTS \`lovely_sync_log\` (
      \`sync_date\`     DATE        NOT NULL,
      \`synced_at\`     DATETIME    NOT NULL,
      \`status\`        VARCHAR(32) NOT NULL DEFAULT 'success',
      \`records_count\` INT         NOT NULL DEFAULT 0,
      PRIMARY KEY (\`sync_date\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_clients: `
    CREATE TABLE IF NOT EXISTS \`lovely_clients\` (
      \`client_id\`    VARCHAR(64) NOT NULL,
      \`first_name\`   VARCHAR(255) DEFAULT NULL,
      \`last_name\`    VARCHAR(255) DEFAULT NULL,
      \`clinic_name\`  VARCHAR(255) DEFAULT NULL,
      \`email\`        VARCHAR(255) DEFAULT NULL,
      \`mobile_phone\` VARCHAR(64)  DEFAULT NULL,
      \`city\`         VARCHAR(128) DEFAULT NULL,
      \`status\`       VARCHAR(32)  NOT NULL DEFAULT 'Active',
      PRIMARY KEY (\`client_id\`),
      KEY \`idx_client_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_patients: `
    CREATE TABLE IF NOT EXISTS \`lovely_patients\` (
      \`patient_id\`   VARCHAR(64) NOT NULL,
      \`patient_name\` VARCHAR(255) DEFAULT NULL,
      \`client_id\`    VARCHAR(64) DEFAULT NULL,
      \`birth_date\`   VARCHAR(64) DEFAULT NULL,
      \`species\`      VARCHAR(64) DEFAULT NULL,
      \`breed\`        VARCHAR(128) DEFAULT NULL,
      \`gender\`       VARCHAR(32) DEFAULT NULL,
      \`neutered\`     VARCHAR(32) DEFAULT 'FALSE',
      \`status\`       VARCHAR(32) NOT NULL DEFAULT 'Active',
      PRIMARY KEY (\`patient_id\`),
      KEY \`idx_patient_client\` (\`client_id\`),
      KEY \`idx_patient_species\` (\`species\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_appointments: `
    CREATE TABLE IF NOT EXISTS \`lovely_appointments\` (
      \`appointment_id\`         VARCHAR(64) NOT NULL,
      \`client_id\`              VARCHAR(64) DEFAULT NULL,
      \`patient_id\`             VARCHAR(64) DEFAULT NULL,
      \`clinic_name\`            VARCHAR(255) DEFAULT NULL,
      \`appointment_start_time\` DATETIME DEFAULT NULL,
      \`appointment_end_time\`   DATETIME DEFAULT NULL,
      \`appointment_status\`     VARCHAR(64) DEFAULT 'Pending',
      \`appointment_type_name\`  VARCHAR(128) DEFAULT NULL,
      \`reason_for_visit\`       VARCHAR(255) DEFAULT NULL,
      \`staff_id\`               VARCHAR(64) DEFAULT NULL,
      PRIMARY KEY (\`appointment_id\`),
      KEY \`idx_appt_start\` (\`appointment_start_time\`),
      KEY \`idx_appt_status\` (\`appointment_status\`),
      KEY \`idx_appt_client\` (\`client_id\`),
      KEY \`idx_appt_patient\` (\`patient_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_staff: `
    CREATE TABLE IF NOT EXISTS \`lovely_staff\` (
      \`staff_id\`   VARCHAR(64) NOT NULL,
      \`staff_name\` VARCHAR(255) NOT NULL,
      \`role\`       VARCHAR(128) DEFAULT NULL,
      PRIMARY KEY (\`staff_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_clinics: `
    CREATE TABLE IF NOT EXISTS \`lovely_clinics\` (
      \`clinic_id\`   VARCHAR(64) NOT NULL,
      \`clinic_name\` VARCHAR(255) NOT NULL,
      PRIMARY KEY (\`clinic_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  lovely_patient_diagnosis: `
    CREATE TABLE IF NOT EXISTS \`lovely_patient_diagnosis\` (
      \`lab_report_id\`           VARCHAR(64)  NOT NULL,
      \`lab_report_no\`           VARCHAR(128) DEFAULT NULL,
      \`clinic_id\`               VARCHAR(64)  DEFAULT NULL,
      \`clinic_name\`             VARCHAR(255) DEFAULT NULL,
      \`patient_id\`              VARCHAR(64)  DEFAULT NULL,
      \`patient_name\`            VARCHAR(255) DEFAULT NULL,
      \`client_id\`               VARCHAR(64)  DEFAULT NULL,
      \`plan_item_name\`          VARCHAR(255) DEFAULT NULL,
      \`plan_category_name\`      VARCHAR(255) DEFAULT NULL,
      \`report_date\`             DATETIME     DEFAULT NULL,
      \`status\`                  VARCHAR(128) DEFAULT NULL,
      \`provider_name\`           VARCHAR(255) DEFAULT NULL,
      PRIMARY KEY (\`lab_report_id\`),
      INDEX \`idx_dx_client\`     (\`client_id\`),
      INDEX \`idx_dx_patient\`    (\`patient_id\`),
      INDEX \`idx_dx_date\`       (\`report_date\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `
};

async function bootstrap() {
  const dbName = process.env.DB_NAME || "cohort_lovely_pets";
  console.log(`🚀 Starting Bootstrap on Host: ${process.env.DB_HOST}`);

  // 1. Establish a connection without database specified to create it
  const adminPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
  });

  try {
    console.log(`⚙️  Step 1: Attempting to CREATE DATABASE \`${dbName}\` if not exists...`);
    try {
      await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      console.log(`✅ Database \`${dbName}\` successfully validated/created.`);
    } catch (dbErr) {
      console.warn(`⚠️  Warning: Could not create database '${dbName}' automatically (${dbErr.message}).`);
      console.log(`💡 Continuing bootstrap assuming you have access to connect to database \`${dbName}\` directly.`);
    } finally {
      await adminPool.end();
    }

    // 2. Connect directly to the new/target database
    console.log(`\n🔌 Step 2: Connecting directly to DB: \`${dbName}\`...`);
    const dbPool = mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "3306"),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: dbName,
    });

    console.log(`✅ Successfully connected to \`${dbName}\`.`);

    // 3. Create tables
    console.log("\n📐 Step 3: Creating schema tables...");
    for (const [tableName, createSql] of Object.entries(TABLES)) {
      process.stdout.write(` -> Creating table \`${tableName}\` ... `);
      await dbPool.query(createSql);
      console.log("DONE");
    }

    console.log("\n🎉 Bootstrap Completed Successfully!");
    await dbPool.end();
    return true;

  } catch (err) {
    console.error("\n❌ Bootstrap Failed Critical Error:", err.message);
    console.error("Make sure your database credentials in .env are valid, and that the user has proper grants.");
    return false;
  }
}

module.exports = bootstrap;

if (require.main === module) {
  bootstrap();
}
