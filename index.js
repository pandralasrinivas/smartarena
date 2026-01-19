// index _fixed.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const ExcelJS = require("exceljs");
const { client, db } = require("./db");
const multer = require("multer");

const SECRET = process.env.JWT_SECRET || "your_super_secret_key";
const PORT = process.env.PORT || 5000;

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

/* -----------------------
  Utilities
------------------------*/
function formatDateForExcel(input) {
  if (!input) return "";
  const d = new Date(input);
  if (isNaN(d)) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function parseDateForImport(val) {
  if (!val && val !== 0) return null;
  if (val instanceof Date) {
    if (isNaN(val)) return null;
    return val.toISOString();
  }
  const s = String(val).trim();
  if (!s) return null;
  // Accept YYYY-MM-DD or ISO or common formats
  // Try ISO first
  const iso = new Date(s);
  if (!isNaN(iso)) return iso.toISOString();
  // fallback to dd/mm/yyyy or dd-mm-yyyy
  const parts = s.match(/^(\d{1,2})[\s\/\-](\d{1,2})[\s\/\-](\d{4})$/);
  if (parts) {
    const day = Number(parts[1]);
    const month = Number(parts[2]) - 1;
    const year = Number(parts[3]);
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d)) return d.toISOString();
  }
  return null;
}

function normalizeBodyKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) {
    const nk = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    out[nk] = obj[k];
  }
  return out;
}

/* -----------------------
  Migrations (all tables with   suffix)
------------------------*/
async function runMigrations() {
  try {
    // Helper to run migration queries but ignore duplicate pg_type errors
    async function safeQuery(sql) {
      try {
        await db.query(sql);
      } catch (err) {
        // Postgres may raise a unique violation on pg_type when a previous
        // failed attempt left a composite type with the same name.
        if (
          err &&
          err.code === "23505" &&
          err.constraint === "pg_type_typname_nsp_index"
        ) {
          console.warn(
            "Migration warning: duplicate pg_type detected, skipping:",
            err.detail || err.message
          );
          return;
        }
        throw err;
      }
    }
    // smartphones
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS smartphones  (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        brand TEXT,
        model TEXT,
        launch_date TIMESTAMP,
        images JSONB,
        colors JSONB,
        build_design JSONB,
        display JSONB,
        performance JSONB,
        camera JSONB,
        battery JSONB,
        connectivity_network JSONB,
        ports JSONB,
        audio JSONB,
        multimedia JSONB,
        sensors TEXT,
        created_at TIMESTAMP DEFAULT now()
      );
    `);

    await safeQuery(`
      CREATE TABLE IF NOT EXISTS smartphone_ratings  (
        id SERIAL PRIMARY KEY,
        smartphone_id INT NOT NULL
          REFERENCES smartphones (id)
          ON DELETE CASCADE,
      
        display NUMERIC CHECK (display BETWEEN 0 AND 5),
        performance NUMERIC CHECK (performance BETWEEN 0 AND 5),
        camera NUMERIC CHECK (camera BETWEEN 0 AND 5),
        battery NUMERIC CHECK (battery BETWEEN 0 AND 5),
        design NUMERIC CHECK (design BETWEEN 0 AND 5),
      
        overall_rating NUMERIC,
        created_at TIMESTAMP DEFAULT now()
      );
      
      `);

    // variants: each variant = ram + storage + color + base_price
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS smartphone_variants  (
        id SERIAL PRIMARY KEY,
      
        smartphone_id INT NOT NULL
          REFERENCES smartphones (id)
          ON DELETE CASCADE,
      
        ram TEXT NOT NULL,
        storage TEXT NOT NULL,
            
        base_price NUMERIC,
      
        created_at TIMESTAMP DEFAULT now(),
      
        -- 🔒 Prevent duplicate variants for same phone
        CONSTRAINT unique_smartphone_variant 
          UNIQUE (smartphone_id, ram, storage)
      );
          `);

    // store prices per variant
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS variant_store_prices  (
        id SERIAL PRIMARY KEY,
      
        variant_id INT NOT NULL
          REFERENCES smartphone_variants (id)
          ON DELETE CASCADE,
      
        store_name TEXT NOT NULL,
      
        price NUMERIC,
        url TEXT,
        offer_text TEXT,
        created_at TIMESTAMP DEFAULT now(),
        -- 🔒 Prevent duplicate store prices
        CONSTRAINT unique_variant_store 
          UNIQUE (variant_id, store_name)
      );
                `);

    // publish metadata
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS smartphone_publish  (
        id SERIAL PRIMARY KEY,
        smartphone_id INTEGER UNIQUE REFERENCES smartphones (id) ON DELETE CASCADE,
        published BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
    `);

    // brands/categories
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        logo TEXT,
        category TEXT,
        status TEXT,
        created_at TIMESTAMP DEFAULT now()
      );
    `);

    // users
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS user_21 (
        id SERIAL PRIMARY KEY,
        user_name TEXT,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        gender TEXT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT now()
      );
    `);

    // additional specs table to store ram, storage and long
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS ram_storage_long  (
        id SERIAL PRIMARY KEY,
        ram TEXT,
        storage TEXT,
        long TEXT,
        created_at TIMESTAMP DEFAULT now()
      );
    `);

    console.log("✅ Migrations to   completed");
  } catch (err) {
    console.error("Migration error:", err);
    throw err;
  }
}

/* -----------------------
  Auth Middleware + Role-Based Access Control (RBAC)
------------------------*/
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token provided" });
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid token" });
  }
}

// roleCheck("admin"), roleCheck("editor","admin"), etc.
function roleCheck(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "Access denied (insufficient role)" });
    }
    next();
  };
}

/* -----------------------
  AUTH Routes
------------------------*/
app.post("/api/auth/register", async (req, res) => {
  try {
    const b = req.body || {};
    const user_name = b.user_name || b.username || b.userName || null;
    const first_name = b.first_name || b.fname || b.firstName || null;
    const last_name = b.last_name || b.lname || b.lastName || null;
    const phone = b.phone || null;
    const gender = b.gender || null;
    const email = b.email || null;
    const password = b.password || null;
    const role = b.role || "admin";

    if (!email || !password)
      return res.status(400).json({ message: "email and password required" });

    const hashed = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO user_21 (user_name, first_name, last_name, phone, gender, email, password, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, user_name, first_name, last_name, phone, gender, email, role, created_at`,
      [user_name, first_name, last_name, phone, gender, email, hashed, role]
    );

    const created = result.rows[0];
    res.status(201).json({ message: "User registered", user: created });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ message: "Email already registered" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "email and password required" });

    const result = await db.query("SELECT * FROM user_21 WHERE email = $1", [
      email,
    ]);
    if (!result.rows.length)
      return res.status(401).json({ message: "Invalid credentials" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        username: user.user_name,
      },
      SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        username: user.user_name,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

/*--- ratings smartphones  ---*/
app.post("/api/public/smartphone/:smartphoneId/rating", async (req, res) => {
  try {
    const smartphoneId = Number(req.params.smartphoneId);

    const { display, performance, camera, battery, design } = req.body;

    // Basic validation
    if (!smartphoneId)
      return res.status(400).json({ message: "Invalid smartphone id" });

    const ratings = [display, performance, camera, battery, design];
    if (ratings.some((r) => typeof r !== "number" || r < 0 || r > 5)) {
      return res.status(400).json({
        message: "All ratings must be numbers between 0 and 5",
      });
    }

    // Calculate overall rating
    const overallRating =
      (display + performance + camera + battery + design) / 5;

    await db.query(
      `
      INSERT INTO smartphone_ratings 
        (smartphone_id, display, performance, camera, battery, design, overall_rating)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7);
      `,
      [
        smartphoneId,
        display,
        performance,
        camera,
        battery,
        design,
        overallRating,
      ]
    );

    res.status(201).json({
      message: "Rating submitted successfully",
      overallRating: Number(overallRating.toFixed(1)),
    });
  } catch (err) {
    console.error("POST rating error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/public/smartphone/:smartphoneId/rating", async (req, res) => {
  try {
    const smartphoneId = Number(req.params.smartphoneId);
    if (!smartphoneId)
      return res.status(400).json({ message: "Invalid smartphone id" });

    const result = await db.query(
      `
      SELECT
        ROUND(AVG(overall_rating), 1) AS "averageRating",
        COUNT(*) AS "totalRatings",
        ROUND(AVG(display), 1) AS display,
        ROUND(AVG(performance), 1) AS performance,
        ROUND(AVG(camera), 1) AS camera,
        ROUND(AVG(battery), 1) AS battery,
        ROUND(AVG(design), 1) AS design
      FROM smartphone_ratings 
      WHERE smartphone_id = $1;
      `,
      [smartphoneId]
    );

    res.json({
      smartphoneId,
      ...result.rows[0],
    });
  } catch (err) {
    console.error("Public GET rating error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put(
  "/api/private/smartphone/:smartphoneId/rating",
  authenticate,

  async (req, res) => {
    console.log(req.body);
    console.log(req.params.smartphoneId);
    try {
      const smartphoneId = Number(req.params.smartphoneId);
      if (!smartphoneId) {
        return res.status(400).json({ message: "Invalid smartphone id" });
      }

      const { display, performance, camera, battery, design } = req.body;

      // Validation
      const ratings = [display, performance, camera, battery, design];
      if (ratings.some((r) => typeof r !== "number" || r < 0 || r > 5)) {
        return res.status(400).json({
          message: "All rating values must be numbers between 0 and 5",
        });
      }

      // Calculate overall rating
      const overallRating =
        (display + performance + camera + battery + design) / 5;

      const result = await db.query(
        `
        UPDATE smartphone_ratings 
        SET
          display = $1,
          performance = $2,
          camera = $3,
          battery = $4,
          design = $5,
          overall_rating = $6
        WHERE id = (
          SELECT id
          FROM smartphone_ratings 
          WHERE smartphone_id = $7
          ORDER BY created_at DESC
          LIMIT 1
        )
        RETURNING *;
        `,
        [
          display,
          performance,
          camera,
          battery,
          design,
          Number(overallRating.toFixed(2)),
          smartphoneId,
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "No rating found to update for this smartphone",
        });
      }

      res.json({
        message: "Rating updated successfully",
        data: result.rows[0],
      });
    } catch (err) {
      console.error("PUT rating error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.delete("/api/private/smartphone/:smartphoneId/rating", async (req, res) => {
  await db.query(`DELETE FROM smartphone_ratings  WHERE smartphone_id=$1`, [
    req.params.smartphoneId,
  ]);

  res.json({ message: "All ratings deleted" });
});

/* -----------------------
  Smartphones CRUD (Option B input format) - tables with   suffix
------------------------*/

// Create smartphone (with variants + variant_store_prices )
app.post("/api/smartphone", authenticate, async (req, res) => {
  const client = await db.connect();
  console.log(req.body);
  try {
    await client.query("BEGIN");

    /* ---------- INSERT SMARTPHONE ---------- */
    const phoneRes = await client.query(
      `
      INSERT INTO smartphones 
        (name, category, brand, model, launch_date,
         images, colors, build_design, display, performance,
         camera, battery, connectivity_network, ports,
         audio, multimedia, sensors)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id;
      `,
      [
        req.body.name,
        req.body.category || null,
        req.body.brand || null,
        req.body.model || null,
        req.body.launch_date || null,
        JSON.stringify(req.body.images || []),
        JSON.stringify(req.body.colors || []),
        JSON.stringify(req.body.build_design || {}),
        JSON.stringify(req.body.display || {}),
        JSON.stringify(req.body.performance || {}),
        JSON.stringify(req.body.camera || {}),
        JSON.stringify(req.body.battery || {}),
        JSON.stringify(req.body.connectivity_network || {}),
        JSON.stringify(req.body.ports || {}),
        JSON.stringify(req.body.audio || {}),
        JSON.stringify(req.body.multimedia || {}),
        req.body.sensors ? JSON.stringify(req.body.sensors) : null,
      ]
    );

    const smartphoneId = phoneRes.rows[0].id;

    /* ---------- INSERT / UPSERT VARIANTS ---------- */
    const variantIds = [];

    for (const v of req.body.variants || []) {
      const vr = await client.query(
        `
        INSERT INTO smartphone_variants 
          (smartphone_id, ram, storage, base_price)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (smartphone_id, ram, storage)
        DO UPDATE SET
          base_price = EXCLUDED.base_price
        RETURNING id;
        `,
        [smartphoneId, v.ram, v.storage, v.base_price || null]
      );
      variantIds.push(vr.rows[0].id);
    }

    /* ---------- UPSERT STORE PRICES ---------- */
    for (const sp of req.body.variant_store_prices || []) {
      let variantId = null;

      if (sp.variant_index !== undefined) {
        variantId = variantIds[sp.variant_index];
      } else if (sp.variant_id) {
        variantId = sp.variant_id;
      }

      if (!variantId) continue;

      await client.query(
        `
        INSERT INTO variant_store_prices 
          (variant_id, store_name, price, url, offer_text)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (variant_id, store_name)
        DO UPDATE SET
          price = EXCLUDED.price,
          url = EXCLUDED.url,
          offer_text = EXCLUDED.offer_text;
        `,
        [
          variantId,
          sp.store_name,
          sp.price || null,
          sp.url || null,
          sp.offer_text || null,
        ]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Smartphone created successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get published smartphones (public) - returns flattened variants as separate rows
// Get published smartphones (public) - nested structure
app.get("/api/smartphone", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        s.id,
        s.name,
        s.category,
        s.brand,
        s.model,
        s.launch_date,
        s.images,
        s.colors,
        s.build_design,
        s.display,
        s.performance,
        s.camera,
        s.battery,
        s.connectivity_network,
        s.ports,
        s.audio,
        s.multimedia,
        s.sensors,
        s.created_at,
        -- include average rating and total ratings (use subqueries to avoid join multiplicity)
        (
          SELECT ROUND(AVG(overall_rating)::numeric, 1)
          FROM smartphone_ratings  r
          WHERE r.smartphone_id = s.id
        ) AS "rating",
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'variant_id', v.id,
              'ram', v.ram,
              'storage', v.storage,
              'base_price', v.base_price,
              'store_prices', (
                SELECT COALESCE(
                  json_agg(
                    jsonb_build_object(
                      'id', sp.id,
                      'store_name', sp.store_name,
                      'price', sp.price,
                      'url', sp.url,
                      'offer_text', sp.offer_text
                    )
                  ),
                  '[]'::json
                )
                FROM variant_store_prices  sp
                WHERE sp.variant_id = v.id
              )
            )
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'::json
        ) AS variants

      FROM smartphones  s
      INNER JOIN smartphone_publish  p
        ON p.smartphone_id = s.id
       AND p.published = true
      LEFT JOIN smartphone_variants  v
        ON v.smartphone_id = s.id

      GROUP BY s.id
      ORDER BY s.id DESC;
    `);

    return res.json({ smartphones: result.rows });
  } catch (err) {
    console.error("GET /api/smartphone error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all smartphones (authenticated) — full data
app.get("/api/smartphones", authenticate, async (req, res) => {
  try {
    const smartphonesRes = await db.query(
      "SELECT * FROM smartphones  ORDER BY id DESC"
    );
    const publishRes = await db.query(
      "SELECT * FROM smartphone_publish  ORDER BY smartphone_id DESC"
    );
    return res.json({
      smartphones: smartphonesRes.rows,
      publish: publishRes.rows,
    });
  } catch (err) {
    console.error("GET /api/smartphones error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Get smartphone by id with variants and store prices
app.get("/api/smartphone/:id", async (req, res) => {
  try {
    const sid = Number(req.params.id);
    if (!sid || Number.isNaN(sid))
      return res.status(400).json({ message: "Invalid id" });

    const sres = await db.query("SELECT * FROM smartphones  WHERE id = $1", [
      sid,
    ]);
    if (!sres.rows.length)
      return res.status(404).json({ message: "Not found" });

    const smartphone = sres.rows[0];
    const variantsRes = await db.query(
      "SELECT * FROM smartphone_variants  WHERE smartphone_id = $1 ORDER BY id ASC",
      [sid]
    );

    const variants = [];
    for (const v of variantsRes.rows) {
      const stores = await db.query(
        "SELECT * FROM variant_store_prices  WHERE variant_id = $1 ORDER BY id ASC",
        [v.id]
      );
      variants.push({ ...v, store_prices: stores.rows });
    }

    return res.json({ data: { ...smartphone, variants } });
  } catch (err) {
    console.error("GET /api/smartphone/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Update smartphone (replace variants & variant_store_prices  if provided) - authenticated
app.put("/api/smartphone/:id", authenticate, async (req, res) => {
  const client = await db.connect();
  console.log(req.body);
  try {
    await client.query("BEGIN");

    const sid = Number(req.params.id);
    if (!sid || Number.isNaN(sid)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid id" });
    }

    const n = normalizeBodyKeys(req.body || {});
    const name = n.name || req.body.name;
    if (!name) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Name is required" });
    }

    /* ---------- UPDATE SMARTPHONE (PARENT) ---------- */
    const updatePhoneSQL = `
      UPDATE smartphones  SET
        name=$1, category=$2, brand=$3, model=$4, launch_date=$5,
        images=$6, colors=$7, build_design=$8, display=$9, performance=$10,
        camera=$11, battery=$12, connectivity_network=$13, ports=$14,
        audio=$15, multimedia=$16, sensors=$17
      WHERE id=$18
      RETURNING *;
    `;

    const phoneRes = await client.query(updatePhoneSQL, [
      name,
      req.body.category || null,
      req.body.brand || null,
      req.body.model || null,
      parseDateForImport(req.body.launch_date),
      JSON.stringify(req.body.images || []),
      JSON.stringify(req.body.colors || []),
      JSON.stringify(req.body.build_design || {}),
      JSON.stringify(req.body.display || {}),
      JSON.stringify(req.body.performance || {}),
      JSON.stringify(req.body.camera || {}),
      JSON.stringify(req.body.battery || {}),
      JSON.stringify(req.body.connectivity_network || {}),
      JSON.stringify(req.body.ports || {}),
      JSON.stringify(req.body.audio || {}),
      JSON.stringify(req.body.multimedia || {}),
      req.body.sensors === null ? null : JSON.stringify(req.body.sensors || []),
      sid,
    ]);

    if (!phoneRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Smartphone not found" });
    }

    /* ---------- UPSERT VARIANTS ---------- */
    if (Array.isArray(req.body.variants)) {
      const variantUpsertSQL = `
        INSERT INTO smartphone_variants 
          (id, smartphone_id, ram, storage,  base_price)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (id)
        DO UPDATE SET
          ram=EXCLUDED.ram,
          storage=EXCLUDED.storage,
          base_price=EXCLUDED.base_price
        RETURNING id;
      `;

      const insertVariantSQL = `
        INSERT INTO smartphone_variants 
          (smartphone_id, ram, storage, base_price)
        VALUES ($1, $2, $3, $4)
        RETURNING id;
      `;

      // Map input variant index -> DB id (useful when client sends variant indices)
      const variantIdMap = [];

      for (let vi = 0; vi < req.body.variants.length; vi++) {
        const v = req.body.variants[vi];
        const ram = v.ram || null;
        const storageVal = v.storage || v.storage_size || null;
        const base_price = v.base_price ?? null;

        if (v.id) {
          const r = await client.query(variantUpsertSQL, [
            v.id,
            sid,
            ram,
            storageVal,
            base_price,
          ]);
          variantIdMap[vi] = r.rows[0].id;
        } else {
          const r = await client.query(insertVariantSQL, [
            sid,
            ram,
            storageVal,
            base_price,
          ]);
          variantIdMap[vi] = r.rows[0].id;
        }
      }

      // expose the mapping for later price handling
      req._variantIdMap = variantIdMap;
    }

    /* ---------- UPSERT STORE PRICES ---------- */
    if (Array.isArray(req.body.variant_store_prices)) {
      const priceUpsertSQL = `
        INSERT INTO variant_store_prices 
          (id, variant_id, store_name, price, url, offer_text)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id)
        DO UPDATE SET
          store_name=EXCLUDED.store_name,
          price=EXCLUDED.price,
          url=EXCLUDED.url,
          offer_text=EXCLUDED.offer_text;
      `;

      const insertPriceSQL = `
        INSERT INTO variant_store_prices 
          (variant_id, store_name, price, url, offer_text)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id;
      `;

      const variantIdMap = req._variantIdMap || [];

      for (const sp of req.body.variant_store_prices) {
        // Resolve variant id: accept either a DB id or an input index (like 0)
        let resolvedVariantId = null;
        if (sp.variant_id !== undefined && sp.variant_id !== null) {
          const vnum = Number(sp.variant_id);
          if (!Number.isNaN(vnum)) {
            if (variantIdMap[vnum]) resolvedVariantId = variantIdMap[vnum];
            else resolvedVariantId = vnum; // treat as DB id
          }
        } else if (
          sp.variant_index !== undefined &&
          sp.variant_index !== null
        ) {
          const idx = Number(sp.variant_index);
          if (!Number.isNaN(idx) && variantIdMap[idx])
            resolvedVariantId = variantIdMap[idx];
        }

        if (!resolvedVariantId) continue; // cannot resolve target variant

        const store_name = sp.store_name || sp.store || null;
        const price = sp.price !== undefined ? Number(sp.price) : null;
        const url = sp.url || null;
        const offer_text = sp.offer_text || sp.offer || null;

        if (sp.id) {
          await client.query(priceUpsertSQL, [
            sp.id,
            resolvedVariantId,
            store_name,
            price,
            url,
            offer_text,
          ]);
        } else {
          await client.query(insertPriceSQL, [
            resolvedVariantId,
            store_name,
            price,
            url,
            offer_text,
          ]);
        }
      }
    }

    await client.query("COMMIT");
    return res.json({
      message: "Smartphone updated successfully",
      data: phoneRes.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PUT /api/smartphone/:id error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete smartphone
app.delete("/api/smartphone/:id", authenticate, async (req, res) => {
  try {
    const sid = Number(req.params.id);
    if (!sid || Number.isNaN(sid))
      return res.status(400).json({ message: "Invalid id" });
    const result = await db.query("DELETE FROM smartphones  WHERE id = $1", [
      sid,
    ]);
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Smartphone not found" });
    return res.json({ message: "Smartphone deleted" });
  } catch (err) {
    console.error("DELETE /api/smartphone/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Delete a color from a smartphone's colors JSONB by index
app.delete(
  "/api/smartphone/:id/color/:index",
  authenticate,
  async (req, res) => {
    try {
      const sid = Number(req.params.id);
      const idx = Number(req.params.index);
      if (!sid || Number.isNaN(sid))
        return res.status(400).json({ message: "Invalid smartphone id" });
      if (Number.isNaN(idx) || idx < 0)
        return res.status(400).json({ message: "Invalid color index" });

      const cur = await db.query(
        "SELECT colors FROM smartphones  WHERE id = $1",
        [sid]
      );
      if (!cur.rows.length)
        return res.status(404).json({ message: "Not found" });
      const colors = cur.rows[0].colors || [];
      if (!Array.isArray(colors) || idx >= colors.length)
        return res.status(400).json({ message: "Color index out of range" });

      const newColors = colors.slice();
      newColors.splice(idx, 1);

      await db.query("UPDATE smartphones  SET colors = $1 WHERE id = $2", [
        JSON.stringify(newColors),
        sid,
      ]);

      return res.json({ message: "Color removed", colors: newColors });
    } catch (err) {
      console.error("DELETE color error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

/* -----------------------
  Ram/Storage/Long API
------------------------*/

// Get all specs (public)
app.get("/api/specs", authenticate, async (req, res) => {
  try {
    const r = await db.query(
      "SELECT * FROM ram_storage_long  ORDER BY id DESC"
    );
    return res.json({ data: r.rows });
  } catch (err) {
    console.error("GET /api/specs error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Create a spec entry (authenticated)
app.post("/api/specs", authenticate, async (req, res) => {
  try {
    const { ram, storage, long } = req.body || {};
    if (!ram && !storage && !long)
      return res
        .status(400)
        .json({ message: "At least one of ram, storage or long is required" });

    const r = await db.query(
      `INSERT INTO ram_storage_long  (ram, storage, long) VALUES ($1,$2,$3) RETURNING *`,
      [ram || null, storage || null, long || null]
    );

    return res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    console.error("POST /api/specs error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Delete a spec entry (authenticated)
app.delete("/api/specs/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || Number.isNaN(id))
      return res.status(400).json({ message: "Invalid id" });

    const r = await db.query("DELETE FROM ram_storage_long  WHERE id = $1", [
      id,
    ]);
    if (r.rowCount === 0)
      return res.status(404).json({ message: "Spec not found" });
    return res.json({ message: "Spec deleted" });
  } catch (err) {
    console.error("DELETE /api/specs/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Delete a variant by id (will cascade-delete store prices via FK)
app.delete("/api/variant/:id", authenticate, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    if (!vid || Number.isNaN(vid))
      return res.status(400).json({ message: "Invalid variant id" });

    const result = await db.query(
      "DELETE FROM smartphone_variants  WHERE id = $1 RETURNING smartphone_id;",
      [vid]
    );
    if (!result.rows.length)
      return res.status(404).json({ message: "Variant not found" });

    return res.json({
      message: "Variant deleted",
      smartphone_id: result.rows[0].smartphone_id,
    });
  } catch (err) {
    console.error("DELETE variant error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Delete a store price entry by id
app.delete("/api/storeprice/:id", authenticate, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    if (!pid || Number.isNaN(pid))
      return res.status(400).json({ message: "Invalid price id" });

    const result = await db.query(
      "DELETE FROM variant_store_prices  WHERE id = $1 RETURNING variant_id;",
      [pid]
    );
    if (!result.rows.length)
      return res.status(404).json({ message: "Store price not found" });

    return res.json({
      message: "Store price deleted",
      variant_id: result.rows[0].variant_id,
    });
  } catch (err) {
    console.error("DELETE storeprice error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -----------------------
  Variants & Store Price endpoints (single-item helpers) -  
------------------------*/

// Create a single variant store price
/* -----------------------
------------------------ */
app.get("/api/publish/status", async (req, res) => {
  try {
    const r = await db.query(
      "SELECT * FROM smartphone_publish  ORDER BY smartphone_id DESC"
    );
    return res.json({ publish: r.rows });
  } catch (err) {
    console.error("GET /api/publish/status error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/smartphone/:id/publish", authenticate, async (req, res) => {
  try {
    const sid = Number(req.params.id);
    if (!sid || Number.isNaN(sid))
      return res.status(400).json({ message: "Invalid id" });
    const { published } = req.body;
    if (typeof published !== "boolean")
      return res.status(400).json({ message: "published must be boolean" });

    const result = await db.query(
      `INSERT INTO smartphone_publish  (smartphone_id, published) VALUES ($1,$2)
       ON CONFLICT (smartphone_id) DO UPDATE SET published = EXCLUDED.published, updated_at = now()
       RETURNING *;`,
      [sid, published]
    );
    return res.json({
      message: "Publish status updated",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("PATCH publish error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -----------------------
  CSV / XLSX Export & Import -  
------------------------*/
// Export (CSV) - authenticated
app.get("/api/smartphones/export", authenticate, async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT s.*, COALESCE(json_agg(json_build_object(
        'id', v.id, 'ram', v.ram, 'storage', coalesce(v.storage,v.storage_size),  'base_price', v.base_price,
        'store_prices', (SELECT coalesce(json_agg(json_build_object('id', sp.id,'store_name',sp.store_name,'price',sp.price,'url',sp.url,'offer_text',sp.offer_text)), '[]'::json) FROM variant_store_prices  sp WHERE sp.variant_id = v.id)
      ) ) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
      FROM smartphones  s
      LEFT JOIN smartphone_variants  v ON v.smartphone_id = s.id
      GROUP BY s.id ORDER BY s.id DESC;
    `);

    const columns = [
      "id",
      "name",
      "category",
      "brand",
      "model",
      "launch_date",
      "images",
      "build_design",
      "display",
      "performance",
      "camera",
      "battery",
      "connectivity_network",
      "ports",
      "audio",
      "multimedia",
      "sensors",
      "variants",
      "created_at",
    ];

    const escapeCell = (val) => {
      if (val === null || val === undefined) return "";
      let s = "";
      if (typeof val === "string") s = val;
      else if (typeof val === "number" || typeof val === "boolean")
        s = String(val);
      else {
        try {
          s = JSON.stringify(val);
        } catch (e) {
          s = String(val);
        }
      }
      s = s.replace(/"/g, '""');
      if (s.includes(",") || s.includes("\n") || s.includes('"'))
        return `"${s}"`;
      return s;
    };

    const lines = [];
    lines.push(columns.join(","));
    for (const r of rows.rows) {
      const line = columns
        .map((col) => {
          if (col === "launch_date" || col === "created_at")
            return escapeCell(r[col] ? new Date(r[col]).toISOString() : "");
          if (
            [
              "images",
              "build_design",
              "display",
              "performance",
              "camera",
              "battery",
              "connectivity_network",
              "ports",
              "audio",
              "multimedia",
              "variants",
            ].includes(col)
          ) {
            const v = r[col];
            return escapeCell(
              v ? (typeof v === "string" ? v : JSON.stringify(v)) : ""
            );
          }
          return escapeCell(r[col]);
        })
        .join(",");
      lines.push(line);
    }

    const csv = lines.join("\r\n");
    const filename = `smartphones_export_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Import smartphones (CSV or XLSX) - authenticated
app.post(
  "/api/smartphones/import",
  authenticate,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer)
        return res.status(400).json({ message: "No file uploaded" });
      const buf = req.file.buffer;
      const originalName = String(req.file.originalname || "").toLowerCase();
      const isCSV =
        originalName.endsWith(".csv") ||
        String(req.file.mimetype || "").includes("csv");

      const parseCSVString = (str) => {
        const lines = str.split(/\r?\n/).filter((l) => l.trim().length);
        if (!lines.length) return { headers: [], rows: [] };
        const parseLine = (line) => {
          const res = [];
          let cur = "";
          let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQ && line[i + 1] === '"') {
                cur += '"';
                i++;
              } else inQ = !inQ;
              continue;
            }
            if (ch === "," && !inQ) {
              res.push(cur);
              cur = "";
              continue;
            }
            cur += ch;
          }
          res.push(cur);
          return res.map((c) => (c === "" ? null : c));
        };
        const headers = parseLine(lines[0]).map((h) =>
          h ? String(h).toLowerCase().trim() : ""
        );
        const rows = lines.slice(1).map((l) => parseLine(l));
        return { headers, rows };
      };

      const parseJSON = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === "object") return v;
        const s = String(v).trim();
        try {
          return JSON.parse(s);
        } catch (e) {
          return s.includes(",") ? s.split(",").map((x) => x.trim()) : s;
        }
      };

      const inserted = [];
      if (isCSV) {
        const text = buf.toString("utf8");
        const parsed = parseCSVString(text);
        const headers = parsed.headers;
        const headerIdx = (k) =>
          headers.findIndex((h) => h === String(k).toLowerCase().trim());
        for (const rowArr of parsed.rows) {
          const read = (...keys) => {
            for (const k of keys) {
              const i = headerIdx(k);
              if (i >= 0) return rowArr[i];
            }
            return null;
          };
          const name = read("name");
          if (!name) continue;
          const category = read("category");
          const brand = read("brand");
          const model = read("model");
          const price = Number(read("price")) || null;
          const launch_date = parseDateForImport(read("launch_date"));
          const images = parseJSON(read("images"));
          const variants = parseJSON(read("variants"));
          // Insert smartphone
          const r = await db.query(
            `INSERT INTO smartphones  (name, category, brand, model, launch_date, images) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id;`,
            [
              name,
              category,
              brand,
              model,
              launch_date,
              JSON.stringify(images || []),
            ]
          );
          const sid = r.rows[0].id;
          // variants (if provided)
          if (Array.isArray(variants)) {
            // detect storage column name for this DB
            let storageCol = "storage";
            try {
              const colRes = await db.query(
                "SELECT column_name FROM information_schema.columns WHERE table_name='smartphone_variants ' AND column_name IN ('storage','storage_size')"
              );
              const cols = colRes.rows.map((r) => r.column_name);
              if (cols.includes("storage")) storageCol = "storage";
              else if (cols.includes("storage_size"))
                storageCol = "storage_size";
            } catch (e) {
              console.warn(
                "Could not detect storage column name (CSV import), defaulting to 'storage'",
                e.message || e
              );
            }

            for (const v of variants) {
              const ram = v.ram || null;
              const storage = v.storage || v.storage_size || null;
              const base_price =
                v.base_price !== undefined ? Number(v.base_price) : null;
              try {
                const vr = await db.query(
                  `INSERT INTO smartphone_variants  (smartphone_id, ram, ${storageCol}, base_price) VALUES ($1,$2,$3,$4) RETURNING id;`,
                  [sid, ram, storage, base_price]
                );
                const vid = vr.rows[0].id;
                // optional store_prices inside variant object?
                if (Array.isArray(v.stores)) {
                  for (const sp of v.stores) {
                    await db.query(
                      `INSERT INTO variant_store_prices  (variant_id, store_name, price, url, offer_text) VALUES ($1,$2,$3,$4,$5)`,
                      [
                        vid,
                        sp.store_name || sp.store || null,
                        sp.price !== undefined ? Number(sp.price) : null,
                        sp.url || null,
                        sp.offer_text || sp.offer || null,
                      ]
                    );
                  }
                }
              } catch (err) {
                if (
                  err &&
                  (err.code === "23502" ||
                    (err.detail && err.detail.includes("storage_size")))
                ) {
                  const altSQL = `INSERT INTO smartphone_variants  (smartphone_id, ram, storage_size, base_price) VALUES ($1,$2,$3,$4) RETURNING id;`;
                  const vr = await db.query(altSQL, [
                    sid,
                    ram,
                    storage,
                    base_price,
                  ]);
                  const vid = vr.rows[0].id;
                  if (Array.isArray(v.stores)) {
                    for (const sp of v.stores) {
                      await db.query(
                        `INSERT INTO variant_store_prices  (variant_id, store_name, price, url, offer_text) VALUES ($1,$2,$3,$4,$5)`,
                        [
                          vid,
                          sp.store_name || sp.store || null,
                          sp.price !== undefined ? Number(sp.price) : null,
                          sp.url || null,
                          sp.offer_text || sp.offer || null,
                        ]
                      );
                    }
                  }
                } else {
                  throw err;
                }
              }
            }
          }
          inserted.push(sid);
        }
        return res.json({
          message: `Imported ${inserted.length} smartphones`,
          inserted,
        });
      } else {
        // XLSX import
        if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
          return res
            .status(415)
            .json({ message: "Invalid XLSX file — upload .xlsx or .csv" });
        }
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buf);
        const sheet = workbook.worksheets[0];
        if (!sheet)
          return res.status(400).json({ message: "No worksheet found" });

        const header = {};
        sheet.getRow(1).eachCell((cell, col) => {
          const key = String(cell.value || "")
            .toLowerCase()
            .trim();
          if (key) header[key] = col;
        });

        const read = (row, ...keys) => {
          for (const k of keys) {
            const col = header[k.toLowerCase()];
            if (col) {
              const c = row.getCell(col).value;
              return c && (c.text || c.result || c);
            }
          }
          return null;
        };

        for (let r = 2; r <= sheet.rowCount; r++) {
          const row = sheet.getRow(r);
          const name = read(row, "name");
          if (!name) continue;
          const category = read(row, "category");
          const brand = read(row, "brand");
          const model = read(row, "model");
          const price = Number(read(row, "price")) || null;
          const launch_date = parseDateForImport(read(row, "launch_date"));
          const images = parseJSON(read(row, "images"));
          const variants = parseJSON(read(row, "variants"));
          const rr = await db.query(
            `INSERT INTO smartphones  (name, category, brand, model,  launch_date, images) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id;`,
            [
              name,
              category,
              brand,
              model,
              launch_date,
              JSON.stringify(images || []),
            ]
          );
          const sid = rr.rows[0].id;
          if (Array.isArray(variants)) {
            // detect storage column name for this DB
            let storageCol = "storage";
            try {
              const colRes = await db.query(
                "SELECT column_name FROM information_schema.columns WHERE table_name='smartphone_variants ' AND column_name IN ('storage','storage_size')"
              );
              const cols = colRes.rows.map((r) => r.column_name);
              if (cols.includes("storage")) storageCol = "storage";
              else if (cols.includes("storage_size"))
                storageCol = "storage_size";
            } catch (e) {
              console.warn(
                "Could not detect storage column name (XLSX import), defaulting to 'storage'",
                e.message || e
              );
            }

            for (const v of variants) {
              const ram = v.ram || null;
              const storage = v.storage || v.storage_size || null;
              const base_price =
                v.base_price !== undefined ? Number(v.base_price) : null;
              try {
                const vr = await db.query(
                  `INSERT INTO smartphone_variants  (smartphone_id, ram, ${storageCol},  base_price) VALUES ($1,$2,$3,$4) RETURNING id;`,
                  [sid, ram, storage, base_price]
                );
                const vid = vr.rows[0].id;
                if (Array.isArray(v.stores)) {
                  for (const sp of v.stores) {
                    await db.query(
                      `INSERT INTO variant_store_prices  (variant_id, store_name, price, url, offer_text) VALUES ($1,$2,$3,$4,$5)`,
                      [
                        vid,
                        sp.store_name || sp.store || null,
                        sp.price !== undefined ? Number(sp.price) : null,
                        sp.url || null,
                        sp.offer_text || sp.offer || null,
                      ]
                    );
                  }
                }
              } catch (err) {
                if (
                  err &&
                  (err.code === "23502" ||
                    (err.detail && err.detail.includes("storage_size")))
                ) {
                  const altSQL = `INSERT INTO smartphone_variants  (smartphone_id, ram, storage_size, base_price) VALUES ($1,$2,$3,$4) RETURNING id;`;
                  const vr = await db.query(altSQL, [
                    sid,
                    ram,
                    storage,
                    base_price,
                  ]);
                  const vid = vr.rows[0].id;
                  if (Array.isArray(v.stores)) {
                    for (const sp of v.stores) {
                      await db.query(
                        `INSERT INTO variant_store_prices  (variant_id, store_name, price, url, offer_text) VALUES ($1,$2,$3,$4,$5)`,
                        [
                          vid,
                          sp.store_name || sp.store || null,
                          sp.price !== undefined ? Number(sp.price) : null,
                          sp.url || null,
                          sp.offer_text || sp.offer || null,
                        ]
                      );
                    }
                  }
                } else {
                  throw err;
                }
              }
            }
          }
          inserted.push(sid);
        }
        return res.json({
          message: `Imported ${inserted.length} smartphones`,
          inserted,
        });
      }
    } catch (err) {
      console.error("Import error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

/* -----------------------
  Brands (categories)
------------------------*/
app.get("/api/categories", async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM brands ORDER BY id DESC");
    return res.json(r.rows);
  } catch (err) {
    console.error("GET /api/categories error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/categories", authenticate, async (req, res) => {
  try {
    const { name, logo, category, status } = req.body;
    if (!name) return res.status(400).json({ message: "Name required" });
    const r = await db.query(
      "INSERT INTO brands (name, logo, category, status) VALUES ($1,$2,$3,$4) RETURNING *;",
      [name, logo || null, category || null, status || null]
    );
    return res.json({ message: "Category created", data: r.rows[0] });
  } catch (err) {
    console.error("POST /api/categories error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.put("/api/categories/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });
    const { name, logo, category, status } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries({ name, logo, category, status })) {
      if (v !== undefined) {
        updates.push(`${k} = $${idx}`);
        values.push(v);
        idx++;
      }
    }
    if (!updates.length)
      return res.status(400).json({ message: "No fields to update" });
    values.push(id);
    const sql = `UPDATE brands SET ${updates.join(
      ", "
    )} WHERE id = $${idx} RETURNING *;`;
    const r = await db.query(sql, values);
    if (!r.rows.length)
      return res.status(404).json({ message: "Category not found" });
    return res.json({ message: "Category updated", data: r.rows[0] });
  } catch (err) {
    console.error("PUT /api/categories/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/categories/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });
    const r = await db.query("DELETE FROM brands WHERE id = $1", [id]);
    if (r.rowCount === 0)
      return res.status(404).json({ message: "Category not found" });
    return res.json({ message: "Category deleted" });
  } catch (err) {
    console.error("DELETE /api/categories/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -----------------------
  Misc helper endpoints -  
------------------------*/

// Get variants for a smartphone
app.get("/api/smartphone/:id/variants", async (req, res) => {
  try {
    const sid = Number(req.params.id);
    if (!sid) return res.status(400).json({ message: "Invalid id" });
    const r = await db.query(
      "SELECT * FROM smartphone_variants  WHERE smartphone_id = $1 ORDER BY id ASC",
      [sid]
    );
    return res.json(r.rows);
  } catch (err) {
    console.error("GET variants error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Get store prices for variant
app.get("/api/variant/:id/store-prices", async (req, res) => {
  try {
    const vid = Number(req.params.id);
    if (!vid) return res.status(400).json({ message: "Invalid id" });
    const r = await db.query(
      "SELECT * FROM variant_store_prices  WHERE variant_id = $1 ORDER BY id ASC",
      [vid]
    );
    return res.json(r.rows);
  } catch (err) {
    console.error("GET variant store prices error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -----------------------
  RBAC (DB-driven) Migrations + Helpers + APIs
  - roles
  - permissions
  - role_permissions (many-to-many)
  - user_roles (assign multiple roles to users)
  - permissionCheck middleware
------------------------*/

async function ensureRBACTables(client) {
  // create RBAC tables (if not exist)
  await client.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      title TEXT,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT now(),
      UNIQUE(role_id, permission_id)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES user_21(id) ON DELETE CASCADE,
      role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT now(),
      UNIQUE(user_id, role_id)
    );
  `);

  // seed some default roles and permissions if empty
  const r = await client.query("SELECT count(*)::int AS c FROM roles");
  if (r.rows[0].c === 0) {
    await client.query(`INSERT INTO roles (name, title) VALUES
      ('admin','Administrator'),
      ('editor','Editor'),
      ('viewer','Viewer')`);
  }

  const p = await client.query("SELECT count(*)::int AS c FROM permissions");
  if (p.rows[0].c === 0) {
    await client.query(`INSERT INTO permissions (name, description) VALUES
      ('create_smartphone','Create smartphone'),
      ('update_smartphone','Update smartphone'),
      ('delete_smartphone','Delete smartphone'),
      ('view_smartphone','View smartphone'),
      ('manage_users','Manage users'),
      ('publish_smartphone','Publish smartphone'),
      ('edit_store_prices','Edit store prices')`);
  }

  // ensure admin role has all permissions
  await client.query(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
    WHERE r.name = 'admin'
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  `);
}

// call ensureRBACTables during migrations
async function runRBACMigrations() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await ensureRBACTables(client);
    await client.query("COMMIT");
    console.log("✅ RBAC tables ensured");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("RBAC migration error:", err);
    throw err;
  } finally {
    client.release();
  }
}

// permissionCheck middleware
function permissionCheck(requiredPermission) {
  return async (req, res, next) => {
    try {
      if (!req.user)
        return res.status(401).json({ message: "Not authenticated" });
      // try to use role_id from token if present
      let roleId = req.user.role_id || null;
      let roleName = req.user.role || null;

      if (!roleId && roleName) {
        const rr = await db.query("SELECT id FROM roles WHERE name = $1", [
          roleName,
        ]);
        if (rr.rows.length) roleId = rr.rows[0].id;
      }

      if (!roleId) {
        // look up user's assigned roles in DB
        const ur = await db.query(
          "SELECT role_id FROM user_roles WHERE user_id = $1",
          [req.user.id]
        );
        if (!ur.rows.length)
          return res.status(403).json({ message: "No role assigned" });
        roleId = ur.rows[0].role_id; // take first role for simplicity
      }

      const perm = await db.query(
        `SELECT p.* FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = $1 AND p.name = $2 LIMIT 1`,
        [roleId, requiredPermission]
      );
      if (!perm.rows.length)
        return res.status(403).json({ message: "Permission denied" });
      next();
    } catch (err) {
      console.error("permissionCheck error:", err);
      return res.status(500).json({ error: "Permission check failed" });
    }
  };
}

/* -----------------------
  RBAC Management APIs
------------------------*/

// Roles
app.get(
  "/api/rbac/roles",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const r = await db.query("SELECT * FROM roles ORDER BY id");
      res.json(r.rows);
    } catch (err) {
      console.error("GET roles error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.post(
  "/api/rbac/roles",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const { name, title } = req.body;
      if (!name) return res.status(400).json({ message: "name required" });
      const r = await db.query(
        "INSERT INTO roles (name, title) VALUES ($1,$2) RETURNING *",
        [name, title || null]
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("POST roles error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.put(
  "/api/rbac/roles/:id",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { name, title } = req.body;
      if (!id) return res.status(400).json({ message: "Invalid id" });
      const r = await db.query(
        "UPDATE roles SET name = COALESCE($1,name), title = COALESCE($2,title) WHERE id = $3 RETURNING *",
        [name || null, title || null, id]
      );
      if (!r.rows.length)
        return res.status(404).json({ message: "Role not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("PUT roles error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.delete(
  "/api/rbac/roles/:id",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });
      await db.query("DELETE FROM roles WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (err) {
      console.error("DELETE roles error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Permissions
app.get(
  "/api/rbac/permissions",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const r = await db.query("SELECT * FROM permissions ORDER BY id");
      res.json(r.rows);
    } catch (err) {
      console.error("GET permissions error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.post(
  "/api/rbac/permissions",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ message: "name required" });
      const r = await db.query(
        "INSERT INTO permissions (name, description) VALUES ($1,$2) RETURNING *",
        [name, description || null]
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("POST permissions error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.delete(
  "/api/rbac/permissions/:id",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });
      await db.query("DELETE FROM permissions WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (err) {
      console.error("DELETE permissions error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Assign permission to role
app.post(
  "/api/rbac/roles/:roleId/permissions",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const roleId = Number(req.params.roleId);
      const { permission_id } = req.body;
      if (!roleId || !permission_id)
        return res
          .status(400)
          .json({ message: "roleId & permission_id required" });
      await db.query(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT (role_id, permission_id) DO NOTHING",
        [roleId, permission_id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Assign permission error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Remove permission from role
app.delete(
  "/api/rbac/roles/:roleId/permissions/:permissionId",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const roleId = Number(req.params.roleId);
      const permissionId = Number(req.params.permissionId);
      if (!roleId || !permissionId)
        return res.status(400).json({ message: "Invalid ids" });
      await db.query(
        "DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2",
        [roleId, permissionId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Remove permission error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Assign role to user
app.post(
  "/api/rbac/users/:userId/roles",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const { role_id } = req.body;
      if (!userId || !role_id)
        return res.status(400).json({ message: "userId & role_id required" });
      await db.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT (user_id, role_id) DO NOTHING",
        [userId, role_id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Assign role to user error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Remove role from user
app.delete(
  "/api/rbac/users/:userId/roles/:roleId",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const roleId = Number(req.params.roleId);
      if (!userId || !roleId)
        return res.status(400).json({ message: "Invalid ids" });
      await db.query(
        "DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2",
        [userId, roleId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Remove role from user error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Get effective permissions for a user
app.get(
  "/api/rbac/users/:userId/permissions",
  authenticate,
  roleCheck("admin"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!userId) return res.status(400).json({ message: "Invalid userId" });
      const r = await db.query(
        `
      SELECT DISTINCT p.* FROM user_roles ur
      JOIN role_permissions rp ON ur.role_id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1
    `,
        [userId]
      );
      res.json(r.rows);
    } catch (err) {
      console.error("Get user permissions error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/* -----------------------
  Start server
------------------------*/
async function start() {
  try {
    // Wait for DB to be reachable before running migrations
    try {
      await db.waitForConnection(
        Number(process.env.DB_CONN_RETRIES) || 5,
        Number(process.env.DB_CONN_RETRY_DELAY_MS) || 5000
      );
    } catch (err) {
      console.error("DB not reachable after retries:", err);
      throw err;
    }

    await runMigrations();
    await runRBACMigrations();
  } catch (err) {
    console.error("Migrations failed:", err);
    process.exit(1);
  }

  app.listen(PORT, async () => {
    console.log(`🚀 Server running port ${PORT}`);
    try {
      const r = await db.query("SELECT now()");
      console.log("DB time:", r.rows[0].now);
    } catch (err) {
      console.error("DB health check failed:", err);
    }
  });
}

start();

module.exports = app;
