const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "database-1.czkao8mcuua1.ap-south-1.rds.amazonaws.com",
  database: "testdb",
  password: "Srinivasarena25",
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

pool.on("connect", () => {
  console.log("✅ PostgreSQL connected");
});

async function waitForConnection(retries = 5, delayMs = 5000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error("Unable to connect to DB");
}

const db = {
  query: (text, params) => pool.query(text, params),
  connect: () => pool.connect(), // IMPORTANT
  waitForConnection,
};

module.exports = { pool, db };
