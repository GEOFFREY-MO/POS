import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Role = "admin" | "seller";

type BuildServerOptions = {
  dbPath: string;
};

type Db = Database.Database;

const now = () => Date.now();

const ensureSchema = (db: Db) => {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES',
      tax_rate REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS sellers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','seller')),
      pin TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      barcode TEXT UNIQUE,
      category TEXT,
      cost_price REAL NOT NULL,
      base_price REAL NOT NULL,
      tax_rate REAL NOT NULL DEFAULT 0,
      stock_qty REAL NOT NULL DEFAULT 0,
      low_stock_alert REAL DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      cost_price REAL NOT NULL DEFAULT 0,
      suggested_price REAL,
      tax_rate REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      device_id TEXT NOT NULL REFERENCES devices(id),
      seller_id TEXT NOT NULL REFERENCES sellers(id),
      seller_name TEXT NOT NULL,
      receipt_no INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      payments_json TEXT,
      total_amount REAL NOT NULL,
      total_extra_value REAL NOT NULL DEFAULT 0,
      total_tax REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('product','service')),
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      base_price REAL,
      final_price REAL NOT NULL,
      extra_value REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 1,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0
    );`,
    `CREATE TABLE IF NOT EXISTS kpi_rules (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      point_per_extra_value REAL NOT NULL DEFAULT 0.1,
      points_per_service REAL NOT NULL DEFAULT 0,
      bonus_threshold REAL DEFAULT NULL,
      bonus_points REAL DEFAULT NULL,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS kpi_points (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      seller_id TEXT NOT NULL REFERENCES sellers(id),
      points REAL NOT NULL,
      extra_value REAL NOT NULL,
      services_sold INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS extra_value_logs (
      id TEXT PRIMARY KEY,
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
      seller_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      extra_value REAL NOT NULL,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      branch_id TEXT NOT NULL REFERENCES branches(id),
      seller_id TEXT NOT NULL REFERENCES sellers(id),
      seller_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      reason TEXT NOT NULL,
      restock INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      last_synced_at INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('push','pull')),
      file_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','success','failed')),
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      business_name TEXT NOT NULL,
      logo_path TEXT,
      po_box TEXT,
      town TEXT,
      tel_no TEXT,
      cu_serial_no TEXT,
      cu_invoice_no TEXT,
      kra_pin TEXT,
      return_policy TEXT,
      currency TEXT NOT NULL DEFAULT 'KES',
      tax_rate REAL NOT NULL DEFAULT 0,
      receipt_header TEXT,
      receipt_footer TEXT,
      backup_path TEXT,
      auth_secret TEXT,
      google_sheet_url TEXT,
      loyalty_points_rate REAL NOT NULL DEFAULT 0.01,
      loyalty_redeem_rate REAL NOT NULL DEFAULT 0.01,
      low_stock_sound_enabled INTEGER NOT NULL DEFAULT 1,
      tax_included INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS backup_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','failed')),
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL CHECK(movement_type IN ('sale','add','adjustment','damage','return','initial')),
      quantity_change REAL NOT NULL,
      before_qty REAL NOT NULL,
      after_qty REAL NOT NULL,
      reason TEXT,
      performed_by TEXT REFERENCES sellers(id),
      sale_id TEXT REFERENCES sales(id),
      created_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES sellers(id),
      action_type TEXT NOT NULL CHECK(action_type IN ('pin_reset','pin_change','price_change','product_add','product_edit','product_delete','inventory_adjust','employee_add','employee_edit','admin_action','settings_change','sale','return','edit_request_created','edit_request_approved','edit_request_rejected','edit_request_completed','expense_created','expense_approved','expense_rejected','expense_deleted')),
      target_id TEXT,
      target_type TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );`,
  ];

  for (const stmt of stmts) {
    db.exec(stmt);
  }

  // Lightweight migrations for existing installs
  try {
    const cols = db.prepare("PRAGMA table_info(products)").all() as any[];
    const hasExpiry = cols.some((c) => String(c?.name) === "expiry_date");
    if (!hasExpiry) {
      db.exec("ALTER TABLE products ADD COLUMN expiry_date INTEGER");
    }
  } catch {
    // ignore
  }

  try {
    const cols = db.prepare("PRAGMA table_info(settings)").all() as any[];
    const have = new Set(cols.map((c) => String(c?.name)));
    const add = (name: string, sqlType: string) => {
      if (!have.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${name} ${sqlType}`);
    };
    add("po_box", "TEXT");
    add("town", "TEXT");
    add("tel_no", "TEXT");
    add("cu_serial_no", "TEXT");
    add("cu_invoice_no", "TEXT");
    add("kra_pin", "TEXT");
    add("return_policy", "TEXT");
    add("auth_secret", "TEXT");
    add("google_sheet_url", "TEXT");
    add("loyalty_points_rate", "REAL NOT NULL DEFAULT 0.01");
    add("loyalty_redeem_rate", "REAL NOT NULL DEFAULT 0.01");
    add("low_stock_sound_enabled", "INTEGER NOT NULL DEFAULT 1");
  } catch {
    // ignore
  }

  try {
    const cols = db.prepare("PRAGMA table_info(sales)").all() as any[];
    const have = new Set(cols.map((c) => String(c?.name)));
    if (!have.has("payments_json")) {
      db.exec("ALTER TABLE sales ADD COLUMN payments_json TEXT");
    }
    if (!have.has("customer_id")) {
      db.exec("ALTER TABLE sales ADD COLUMN customer_id TEXT");
    }
    if (!have.has("points_earned")) {
      db.exec("ALTER TABLE sales ADD COLUMN points_earned REAL NOT NULL DEFAULT 0");
    }
    if (!have.has("points_redeemed")) {
      db.exec("ALTER TABLE sales ADD COLUMN points_redeemed REAL NOT NULL DEFAULT 0");
    }
  } catch {
    // ignore
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed','retrying')),
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_attempt_at INTEGER
    );`);
  } catch {
    // ignore
  }

  // Migration: add attempt_count and next_retry_at to sync_queue if missing
  try {
    const cols = db.prepare("PRAGMA table_info(sync_queue)").all() as any[];
    const have = new Set(cols.map((c) => String(c?.name)));
    if (!have.has("attempt_count")) {
      db.exec("ALTER TABLE sync_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!have.has("next_retry_at")) {
      db.exec("ALTER TABLE sync_queue ADD COLUMN next_retry_at INTEGER");
    }
  } catch {
    // ignore
  }

  // Sync tracker to avoid duplicates
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_tracker (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_type TEXT NOT NULL UNIQUE,
      last_synced_id TEXT,
      last_synced_at INTEGER,
      last_synced_date TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );`);
    // Initialize tracker records if not exist
    const types = ["sales", "sale_items", "products", "returns", "inventory_movements", "customers", "daily_accounts", "expenses"];
    types.forEach((t) => {
      db.prepare("INSERT OR IGNORE INTO sync_tracker (data_type, record_count, updated_at) VALUES (?, 0, ?)").run(t, now());
    });
  } catch {
    // ignore
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT UNIQUE,
      points REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      sale_id TEXT NOT NULL REFERENCES sales(id),
      points_earned REAL NOT NULL DEFAULT 0,
      points_redeemed REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`);
  } catch {
    // ignore
  }

  // Edit requests system for employee -> admin notifications
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS edit_requests (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      requested_by TEXT NOT NULL REFERENCES sellers(id),
      request_type TEXT NOT NULL CHECK(request_type IN ('stock_adjustment','price_change','product_edit','other')),
      reason TEXT NOT NULL,
      requested_field TEXT,
      current_value TEXT,
      requested_value TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','completed')),
      approved_by TEXT REFERENCES sellers(id),
      approved_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );`);
  } catch {
    // ignore
  }

  // Migration: update audit_logs CHECK constraint to include new action types
  try {
    // Check if we need to migrate by testing if new action types work
    const testId = `_test_${Date.now()}`;
    try {
      db.prepare("INSERT INTO audit_logs (id, action_type, created_at) VALUES (?, 'edit_request_created', ?)").run(testId, Date.now());
      db.prepare("DELETE FROM audit_logs WHERE id = ?").run(testId);
      // If we get here, the constraint is already updated
    } catch {
      // Constraint is old, need to migrate
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs_new (
          id TEXT PRIMARY KEY,
          user_id TEXT REFERENCES sellers(id),
          action_type TEXT NOT NULL CHECK(action_type IN ('pin_reset','pin_change','price_change','product_add','product_edit','product_delete','inventory_adjust','employee_add','employee_edit','admin_action','settings_change','sale','return','edit_request_created','edit_request_approved','edit_request_rejected','edit_request_completed','expense_created','expense_approved','expense_rejected','expense_deleted')),
          target_id TEXT,
          target_type TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO audit_logs_new SELECT * FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_new RENAME TO audit_logs;
      `);
    }
  } catch {
    // ignore migration errors
  }

  // Migration: add added_by to products to track who added them
  try {
    const cols = db.prepare("PRAGMA table_info(products)").all() as any[];
    const has = cols.some((c) => String(c?.name) === "added_by");
    if (!has) {
      db.exec("ALTER TABLE products ADD COLUMN added_by TEXT");
    }
  } catch {
    // ignore
  }

  try {
    const cols = db.prepare("PRAGMA table_info(services)").all() as any[];
    const has = cols.some((c) => String(c?.name) === "cost_price");
    if (!has) {
      db.exec("ALTER TABLE services ADD COLUMN cost_price REAL NOT NULL DEFAULT 0");
    }
  } catch {
    // ignore
  }

  // Expenses table for offline accounting
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      category TEXT,
      amount REAL NOT NULL,
      expense_date INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES sellers(id),
      branch_id TEXT REFERENCES branches(id),
      employee_entered INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT REFERENCES sellers(id),
      approved_at INTEGER,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
  } catch {
    // ignore
  }

  // Services sales table (separate from product sales)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS service_sales (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      service_id TEXT REFERENCES services(id),
      service_type TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      total REAL NOT NULL,
      cashier_id TEXT NOT NULL REFERENCES sellers(id),
      branch_id TEXT NOT NULL REFERENCES branches(id),
      created_at INTEGER NOT NULL
    );`);
  } catch {
    // ignore
  }

  // Migration: add allowEmployeeExpenses to settings
  try {
    const cols = db.prepare("PRAGMA table_info(settings)").all() as any[];
    const has = cols.some((c) => String(c?.name) === "allow_employee_expenses");
    if (!has) {
      db.exec("ALTER TABLE settings ADD COLUMN allow_employee_expenses INTEGER NOT NULL DEFAULT 0");
    }
  } catch {
    // ignore
  }
};

const ensureDb = (dbPath: string): Db => {
  const db = new Database(dbPath);
  // Performance optimizations for SQLite
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // Faster writes, still safe with WAL
  db.pragma("cache_size = -64000"); // 64MB cache
  db.pragma("temp_store = MEMORY"); // Store temp tables in memory
  db.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  
  // Create indexes for faster queries (only if they don't exist)
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_branch ON sales(branch_id);
      CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
      CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id);
      CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
      CREATE INDEX IF NOT EXISTS idx_expenses_approved ON expenses(approved);
    `);
  } catch {
    // Indexes may already exist
  }
  
  return db;
};

const getNextReceiptNo = (db: Db, branchId: string, deviceId: string) => {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(receipt_no), 0) AS max_receipt FROM sales WHERE branch_id = ? AND device_id = ?"
    )
    .get(branchId, deviceId) as { max_receipt: number } | undefined;
  return (row?.max_receipt ?? 0) + 1;
};

const getKpiRule = (
  db: Db,
  branchId: string
): {
  point_per_extra_value: number;
  points_per_service: number;
  bonus_threshold: number | null;
  bonus_points: number | null;
} => {
  const row = db
    .prepare(
      "SELECT point_per_extra_value, points_per_service, bonus_threshold, bonus_points FROM kpi_rules WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(branchId) as
    | {
        point_per_extra_value: number;
        points_per_service: number;
        bonus_threshold: number | null;
        bonus_points: number | null;
      }
    | undefined;

  return (
    row ?? {
      point_per_extra_value: 0,
      points_per_service: 0,
      bonus_threshold: null,
      bonus_points: null,
    }
  );
};

const settingsSchema = z.object({
  businessName: z.string().min(1),
  logoPath: z.string().nullable().optional(),
  poBox: z.string().nullable().optional(),
  town: z.string().nullable().optional(),
  telNo: z.string().nullable().optional(),
  cuSerialNo: z.string().nullable().optional(),
  cuInvoiceNo: z.string().nullable().optional(),
  kraPin: z.string().nullable().optional(),
  returnPolicy: z.string().nullable().optional(),
  currency: z.string().min(1),
  taxRate: z.number().min(0),
  receiptHeader: z.string().nullable().optional(),
  receiptFooter: z.string().nullable().optional(),
  backupPath: z.string().nullable().optional(),
  googleSheetUrl: z.string().nullable().optional(),
  loyaltyPointsRate: z.number().min(0).default(0.01),
  loyaltyRedeemRate: z.number().min(0).default(0.01),
  lowStockSoundEnabled: z.boolean().default(true),
  taxIncluded: z.boolean().default(false),
});

const branchSchema = z.object({
  name: z.string().min(1),
  currency: z.string().min(1),
  taxRate: z.number().min(0),
});

const deviceSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1),
});

const sellerSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["admin", "seller"]),
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
  active: z.boolean().optional(),
});

const loginSchema = z.object({
  name: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

const productSchema = z.object({
  name: z.string().min(1),
  barcode: z.string().optional(),
  category: z.string().optional(),
  costPrice: z.number().min(0),
  basePrice: z.number().min(0),
  taxRate: z.number().min(0).default(0),
  stockQty: z.number().min(0).default(0),
  lowStockAlert: z.number().min(0).nullable().optional(),
  expiryDate: z.number().nullable().optional(),
});

const serviceSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  costPrice: z.number().min(0).default(0),
  suggestedPrice: z.number().nullable().optional(),
  taxRate: z.number().min(0).default(0),
  notes: z.string().optional(),
});

const kpiRuleSchema = z.object({
  branchId: z.string().min(1),
  pointPerExtraValue: z.number().min(0).default(0),
  pointsPerService: z.number().min(0).default(0),
  bonusThreshold: z.number().nullable().optional(),
  bonusPoints: z.number().nullable().optional(),
});

const saleSchema = z.object({
  branchId: z.string(),
  deviceId: z.string(),
  sellerId: z.string(),
  paymentMethod: z.string(),
  paymentRef: z.string().optional(),
  payments: z
    .object({
      cash: z.number().nonnegative().default(0),
      till: z.number().nonnegative().default(0),
      bank: z.number().nonnegative().default(0),
    })
    .optional(),
  tendered: z.number().nonnegative().optional(),
  change: z.number().optional(),
  customer: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      redeemPoints: z.number().nonnegative().optional(),
    })
    .optional(),
  items: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("product"),
          itemId: z.string(),
          quantity: z.number().positive(),
          finalPrice: z.number().nonnegative(),
        }),
        z.object({
          kind: z.literal("service"),
          itemId: z.string(),
          quantity: z.number().positive().default(1),
          finalPrice: z.number().nonnegative(),
        }),
      ])
    )
    .min(1),
  createdAt: z.number().optional(),
});

const exportSchema = z.object({
  filePath: z.string().optional(),
});

const importSchema = z.object({
  filePath: z.string(),
});

const productBulkSchema = z.object({
  items: z.array(
    productSchema.extend({
      id: z.string().optional(),
    })
  ),
});

type TokenPayload = {
  sellerId: string;
  role: Role;
  exp: number;
  ts: number;
};

const base64url = (buf: Buffer) =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const base64urlToBuffer = (s: string) => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(padded, "base64");
};

const isLegacyPlainPin = (stored: string) => /^\d{4}$/.test(stored);

const hashPin = (pin: string) => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${base64url(salt)}$${base64url(Buffer.from(key))}`;
};

const verifyPin = (pin: string, stored: string) => {
  if (isLegacyPlainPin(stored)) return stored === pin;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = base64urlToBuffer(parts[1]);
  const expected = base64urlToBuffer(parts[2]);
  const actual = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, Buffer.from(actual));
};

export const buildServer = (options: BuildServerOptions): FastifyInstance => {
  const db = ensureDb(options.dbPath);
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });
  app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });

  const badRequest = (msg: string) =>
    (app as any).httpErrors?.badRequest?.(msg) ??
    Object.assign(new Error(msg), { statusCode: 400 });
  const unauthorized = (msg: string) =>
    (app as any).httpErrors?.unauthorized?.(msg) ??
    Object.assign(new Error(msg), { statusCode: 401 });
  const forbidden = (msg: string) =>
    (app as any).httpErrors?.forbidden?.(msg) ??
    Object.assign(new Error(msg), { statusCode: 403 });
  const notFound = (msg: string) =>
    (app as any).httpErrors?.notFound?.(msg) ??
    Object.assign(new Error(msg), { statusCode: 404 });
  const conflict = (msg: string) =>
    Object.assign(new Error(msg), { statusCode: 409 });

  // Helper: Log inventory movement
  const logInventoryMovement = (params: {
    productId: string;
    movementType: "sale" | "add" | "adjustment" | "damage" | "return" | "initial";
    quantityChange: number;
    beforeQty: number;
    afterQty: number;
    reason?: string;
    performedBy?: string;
    saleId?: string;
  }) => {
    const id = nanoid();
    const ts = now();
    db.prepare(
      `INSERT INTO inventory_movements (id, product_id, movement_type, quantity_change, before_qty, after_qty, reason, performed_by, sale_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.productId,
      params.movementType,
      params.quantityChange,
      params.beforeQty,
      params.afterQty,
      params.reason ?? null,
      params.performedBy ?? null,
      params.saleId ?? null,
      ts
    );
    return id;
  };

  // Helper: Log audit action
  const logAudit = (params: {
    userId?: string;
    actionType: string;
    targetId?: string;
    targetType?: string;
    details?: Record<string, any>;
  }) => {
    const id = nanoid();
    const ts = now();
    db.prepare(
      `INSERT INTO audit_logs (id, user_id, action_type, target_id, target_type, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.userId ?? null,
      params.actionType,
      params.targetId ?? null,
      params.targetType ?? null,
      params.details ? JSON.stringify(params.details) : null,
      ts
    );
    return id;
  };

  const secretFilePath = path.join(path.dirname(options.dbPath), "auth.secret");
  const getAuthSecret = () => {
    try {
      if (fs.existsSync(secretFilePath)) {
        return fs.readFileSync(secretFilePath, "utf-8").trim();
      }
      const s = base64url(crypto.randomBytes(32));
      fs.mkdirSync(path.dirname(secretFilePath), { recursive: true });
      fs.writeFileSync(secretFilePath, s, "utf-8");
      return s;
    } catch {
      // fallback (tokens won't survive restarts if we can't write/read the file)
      return base64url(crypto.randomBytes(32));
    }
  };

  const AUTH_SECRET = getAuthSecret();

  const signToken = (payload: TokenPayload) => {
    const body = base64url(Buffer.from(JSON.stringify(payload), "utf-8"));
    const sig = base64url(crypto.createHmac("sha256", AUTH_SECRET).update(body).digest());
    return `${body}.${sig}`;
  };

  const verifyToken = (token: string): TokenPayload | null => {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = base64url(crypto.createHmac("sha256", AUTH_SECRET).update(body).digest());
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    } catch {
      return null;
    }
    try {
      const payload = JSON.parse(base64urlToBuffer(body).toString("utf-8")) as TokenPayload;
      if (!payload?.sellerId || !payload?.role || !payload?.exp) return null;
      if (Date.now() > payload.exp) return null;
      return payload;
    } catch {
      return null;
    }
  };

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const auth = request.headers.authorization;
    if (!auth) return;
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return;
    try {
      const decoded = verifyToken(token);
      if (!decoded) return;
      const exists = db
        .prepare("SELECT id, role, active FROM sellers WHERE id = ?")
        .get(decoded.sellerId) as { id: string; role: Role; active: number } | undefined;
      if (!exists || !exists.active) return;
      (request as any).user = { sellerId: exists.id, role: exists.role };
    } catch {
      return;
    }
  });

  const requireAuth = async (request: any) => {
    if (!request.user) throw unauthorized("Not logged in");
  };
  const requireAdmin = async (request: any) => {
    if (!request.user) throw unauthorized("Not logged in");
    if (request.user.role !== "admin") throw forbidden("Admin only");
  };

  app.get("/health", async () => {
    const branches =
      (db
        .prepare("SELECT COUNT(*) as count FROM branches")
        .get() as { count?: number } | undefined)?.count ?? 0;
    const settings =
      db.prepare("SELECT business_name FROM settings WHERE id = 1").get() ??
      null;
    return { status: "ok", branches, configured: !!settings };
  });

  // Product key verification endpoint
  app.post("/verify-product-key", async (request, reply) => {
    const body = z.object({ productKey: z.string() }).parse(request.body);
    
    // Hash the provided product key using SHA-256
    const providedHash = crypto.createHash("sha256").update(body.productKey.trim()).digest("hex");
    
    // Hash of the valid product key: '@Hii huezi elewa ni kali sana'
    const validProductKey = "@Hii huezi elewa ni kali sana";
    const validHash = crypto.createHash("sha256").update(validProductKey).digest("hex");
    
    if (providedHash === validHash) {
      // Store verification in database (optional - for tracking)
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS license_verifications (
          id TEXT PRIMARY KEY,
          verified_at INTEGER NOT NULL,
          ip_address TEXT
        )`);
        db.prepare("INSERT INTO license_verifications (id, verified_at) VALUES (?, ?)").run(nanoid(), now());
      } catch {
        // Ignore if table creation fails
      }
      return { verified: true, message: "Product key verified successfully" };
    } else {
      return reply.code(401).send({ verified: false, message: "Invalid product key" });
    }
  });

  app.get("/settings", async () => {
    const row = db.prepare("SELECT * FROM settings WHERE id = 1").get() as any;
    if (!row) return null;
    return {
      businessName: row.business_name,
      logoPath: row.logo_path,
      poBox: row.po_box,
      town: row.town,
      telNo: row.tel_no,
      cuSerialNo: row.cu_serial_no,
      cuInvoiceNo: row.cu_invoice_no,
      kraPin: row.kra_pin,
      returnPolicy: row.return_policy,
      currency: row.currency,
      taxRate: row.tax_rate,
      receiptHeader: row.receipt_header,
      receiptFooter: row.receipt_footer,
      backupPath: row.backup_path,
      googleSheetUrl: row.google_sheet_url,
      loyaltyPointsRate: row.loyalty_points_rate ?? 0.01,
      loyaltyRedeemRate: row.loyalty_redeem_rate ?? 0.01,
      lowStockSoundEnabled: row.low_stock_sound_enabled === 1,
      allowEmployeeExpenses: row.allow_employee_expenses === 1,
      taxIncluded: row.tax_included === 1,
    };
  });

  app.put("/settings", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = settingsSchema.partial().parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };

    const updates: string[] = [];
    const values: any[] = [];

    if (input.businessName !== undefined) { updates.push("business_name = ?"); values.push(input.businessName); }
    if (input.logoPath !== undefined) { updates.push("logo_path = ?"); values.push(input.logoPath); }
    if (input.poBox !== undefined) { updates.push("po_box = ?"); values.push(input.poBox); }
    if (input.town !== undefined) { updates.push("town = ?"); values.push(input.town); }
    if (input.telNo !== undefined) { updates.push("tel_no = ?"); values.push(input.telNo); }
    if (input.cuSerialNo !== undefined) { updates.push("cu_serial_no = ?"); values.push(input.cuSerialNo); }
    if (input.cuInvoiceNo !== undefined) { updates.push("cu_invoice_no = ?"); values.push(input.cuInvoiceNo); }
    if (input.kraPin !== undefined) { updates.push("kra_pin = ?"); values.push(input.kraPin); }
    if (input.returnPolicy !== undefined) { updates.push("return_policy = ?"); values.push(input.returnPolicy); }
    if (input.currency !== undefined) { updates.push("currency = ?"); values.push(input.currency); }
    if (input.taxRate !== undefined) { updates.push("tax_rate = ?"); values.push(input.taxRate); }
    if (input.receiptHeader !== undefined) { updates.push("receipt_header = ?"); values.push(input.receiptHeader); }
    if (input.receiptFooter !== undefined) { updates.push("receipt_footer = ?"); values.push(input.receiptFooter); }
    if (input.backupPath !== undefined) { updates.push("backup_path = ?"); values.push(input.backupPath); }
    if (input.googleSheetUrl !== undefined) { updates.push("google_sheet_url = ?"); values.push(input.googleSheetUrl); }
    if (input.loyaltyPointsRate !== undefined) { updates.push("loyalty_points_rate = ?"); values.push(input.loyaltyPointsRate); }
    if (input.loyaltyRedeemRate !== undefined) { updates.push("loyalty_redeem_rate = ?"); values.push(input.loyaltyRedeemRate); }
    if (input.lowStockSoundEnabled !== undefined) { updates.push("low_stock_sound_enabled = ?"); values.push(input.lowStockSoundEnabled ? 1 : 0); }
    if (input.taxIncluded !== undefined) { updates.push("tax_included = ?"); values.push(input.taxIncluded ? 1 : 0); }

    if (updates.length > 0) {
      updates.push("updated_at = ?");
      values.push(now());
      values.push(1); // WHERE id = 1
      db.prepare(`UPDATE settings SET ${updates.join(", ")} WHERE id = ?`).run(...values);

      logAudit({
        userId: u.sellerId,
        actionType: "settings_change",
        targetId: "1",
        targetType: "settings",
        details: input,
      });
    }

    reply.code(204).send();
  });

  app.post("/setup", async (request, reply) => {
    const setupSchema = z.object({
      settings: settingsSchema,
      branch: branchSchema,
      deviceName: z.string().min(1),
      admin: z.object({
        name: z.string().min(1),
        pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
      }),
      kpi: kpiRuleSchema.omit({ branchId: true }),
    });

    const input = setupSchema.parse(request.body);
    const createdAt = now();
    const branchId = nanoid();
    const deviceId = nanoid();
    const adminId = nanoid();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO settings (
          id, business_name, logo_path, po_box, town, tel_no, cu_serial_no, cu_invoice_no,
          kra_pin, return_policy, currency, tax_rate, receipt_header, receipt_footer, backup_path,
          auth_secret, google_sheet_url, loyalty_points_rate, loyalty_redeem_rate, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM settings WHERE id=1), ?), ?)`
      ).run(
        input.settings.businessName,
        input.settings.logoPath ?? null,
        input.settings.poBox ?? null,
        input.settings.town ?? null,
        input.settings.telNo ?? null,
        input.settings.cuSerialNo ?? null,
        input.settings.cuInvoiceNo ?? null,
        input.settings.kraPin ?? null,
        input.settings.returnPolicy ?? null,
        input.settings.currency,
        input.settings.taxRate,
        input.settings.receiptHeader ?? null,
        input.settings.receiptFooter ?? null,
        input.settings.backupPath ?? null,
        AUTH_SECRET,
        input.settings.googleSheetUrl ?? null,
        input.settings.loyaltyPointsRate ?? 0.01,
        input.settings.loyaltyRedeemRate ?? 1,
        createdAt,
        createdAt
      );

      db.prepare(
        "INSERT INTO branches (id, name, currency, tax_rate, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(
        branchId,
        input.branch.name,
        input.branch.currency,
        input.branch.taxRate,
        createdAt
      );

      db.prepare(
        "INSERT INTO devices (id, branch_id, name, created_at) VALUES (?, ?, ?, ?)"
      ).run(deviceId, branchId, input.deviceName, createdAt);

      db.prepare(
        "INSERT INTO sellers (id, name, role, pin, active, created_at) VALUES (?, ?, 'admin', ?, 1, ?)"
      ).run(adminId, input.admin.name, hashPin(input.admin.pin), createdAt);

      db.prepare(
        "INSERT INTO kpi_rules (id, branch_id, point_per_extra_value, points_per_service, bonus_threshold, bonus_points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        nanoid(),
        branchId,
        input.kpi.pointPerExtraValue,
        input.kpi.pointsPerService,
        input.kpi.bonusThreshold ?? null,
        input.kpi.bonusPoints ?? null,
        createdAt
      );

      return { branchId, deviceId, adminId };
    });

    const result = tx();
    reply.code(201).send({ ...result });
  });

  app.post("/branches", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = branchSchema.parse(request.body);
    const id = nanoid();
    const createdAt = now();
    db.prepare(
      "INSERT INTO branches (id, name, currency, tax_rate, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, input.name, input.currency, input.taxRate, createdAt);
    reply.code(201).send({ id, ...input, createdAt });
  });

  app.get("/branches", async () => {
    return db.prepare("SELECT * FROM branches").all();
  });

  app.post("/devices", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = deviceSchema.parse(request.body);
    const exists = db
      .prepare("SELECT id FROM branches WHERE id = ?")
      .get(input.branchId);
    if (!exists) throw badRequest("Branch not found");
    const id = nanoid();
    db.prepare(
      "INSERT INTO devices (id, branch_id, name, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, input.branchId, input.name, now());
    reply.code(201).send({ id, ...input });
  });

  app.post(
    "/settings/google-sheet-url",
    { preHandler: [requireAdmin as any] },
    async (request, reply) => {
      const body = z
        .object({
          url: z.string().url().optional(),
        })
        .parse(request.body ?? {});
      const ts = now();
      db.prepare("UPDATE settings SET google_sheet_url = ?, updated_at = ? WHERE id = 1").run(
        body.url ?? null,
        ts
      );
      reply.code(204).send();
    }
  );

  app.get("/devices", async () => {
    return db.prepare("SELECT * FROM devices").all();
  });

  app.post("/sellers", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = sellerSchema.parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };
    const id = nanoid();
    db.prepare(
      "INSERT INTO sellers (id, name, role, pin, active, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      input.name,
      input.role,
      hashPin(input.pin),
      input.active ?? true ? 1 : 0,
      now()
    );

    // Audit log employee creation
    logAudit({
      userId: u.sellerId,
      actionType: "employee_add",
      targetId: id,
      targetType: "seller",
      details: { name: input.name, role: input.role },
    });

    reply.code(201).send({ id, ...input });
  });

  app.get("/sellers", async () => {
    return db.prepare("SELECT id, name, role, active, created_at FROM sellers").all();
  });

  app.put("/sellers/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const input = sellerSchema.partial().parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };
    const existing = db
      .prepare("SELECT id, name, role, active FROM sellers WHERE id = ?")
      .get(params.id) as { id: string; name: string; role: string; active: number } | undefined;
    if (!existing) throw notFound("Seller not found");
    db.prepare(
      "UPDATE sellers SET name = COALESCE(?, name), role = COALESCE(?, role), pin = COALESCE(?, pin), active = COALESCE(?, active) WHERE id = ?"
    ).run(
      input.name ?? null,
      input.role ?? null,
      input.pin ? hashPin(input.pin) : null,
      input.active === undefined ? null : input.active ? 1 : 0,
      params.id
    );

    // Audit log employee edit (including PIN reset by admin)
    const changes: Record<string, any> = {};
    if (input.name && input.name !== existing.name) changes.name = { from: existing.name, to: input.name };
    if (input.role && input.role !== existing.role) changes.role = { from: existing.role, to: input.role };
    if (input.active !== undefined && (input.active ? 1 : 0) !== existing.active) changes.active = { from: !!existing.active, to: input.active };
    if (input.pin) changes.pinReset = true;

    logAudit({
      userId: u.sellerId,
      actionType: input.pin ? "pin_reset" : "employee_edit",
      targetId: params.id,
      targetType: "seller",
      details: changes,
    });

    reply.send({ id: params.id });
  });

  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const seller = db
      .prepare("SELECT id, role, pin, active FROM sellers WHERE name = ?")
      .get(input.name) as { id: string; role: Role; pin: string; active: number } | undefined;
    if (!seller || !seller.active) throw unauthorized("Invalid credentials");
    if (!verifyPin(input.pin, seller.pin)) throw unauthorized("Invalid credentials");

    // Auto-upgrade legacy plaintext pins to hashed format on successful login.
    if (isLegacyPlainPin(seller.pin)) {
      try {
        db.prepare("UPDATE sellers SET pin = ? WHERE id = ?").run(hashPin(input.pin), seller.id);
      } catch {
        // ignore
      }
    }
    const exp = Date.now() + 12 * 60 * 60 * 1000;
    const token = signToken({ sellerId: seller.id, role: seller.role, ts: Date.now(), exp });
    reply.send({ token, role: seller.role, sellerId: seller.id, exp });
  });

  app.get("/auth/me", { preHandler: [requireAuth as any] }, async (request) => {
    const u = (request as any).user as { sellerId: string; role: Role };
    const row = db
      .prepare("SELECT id, name, role, active FROM sellers WHERE id = ?")
      .get(u.sellerId) as { id: string; name: string; role: Role; active: number } | undefined;
    if (!row || !row.active) throw unauthorized("Not logged in");
    return { sellerId: row.id, name: row.name, role: row.role };
  });

  app.post(
    "/auth/change-pin",
    { preHandler: [requireAdmin as any] },
    async (request, reply) => {
      const u = (request as any).user as { sellerId: string; role: Role };
      const body = z
        .object({
          oldPin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
          newPin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
        })
        .parse(request.body);

      const row = db
        .prepare("SELECT id, pin FROM sellers WHERE id = ? AND role = 'admin'")
        .get(u.sellerId) as { id: string; pin: string } | undefined;
      if (!row) throw unauthorized("Not logged in");
      if (!verifyPin(body.oldPin, row.pin)) throw unauthorized("Invalid credentials");
      db.prepare("UPDATE sellers SET pin = ? WHERE id = ?").run(hashPin(body.newPin), u.sellerId);

      // Audit log admin PIN change
      logAudit({
        userId: u.sellerId,
        actionType: "pin_change",
        targetId: u.sellerId,
        targetType: "seller",
        details: { self: true },
      });

      reply.code(204).send();
    }
  );

  // Allow both admin and sellers to add products
  app.post("/products", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const input = productSchema.parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };
    if (input.barcode) {
      const dup = db.prepare("SELECT id FROM products WHERE barcode = ?").get(input.barcode);
      if (dup) throw badRequest("Barcode already exists");
    }
    const id = nanoid();
    const ts = now();
    db.prepare(
      "INSERT INTO products (id, name, barcode, category, cost_price, base_price, tax_rate, stock_qty, low_stock_alert, expiry_date, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      input.name,
      input.barcode ?? null,
      input.category ?? null,
      input.costPrice,
      input.basePrice,
      input.taxRate,
      input.stockQty,
      input.lowStockAlert ?? null,
      input.expiryDate ?? null,
      u.sellerId,
      ts,
      ts
    );

    // Log initial inventory movement if stock > 0
    if (input.stockQty > 0) {
      logInventoryMovement({
        productId: id,
        movementType: "initial",
        quantityChange: input.stockQty,
        beforeQty: 0,
        afterQty: input.stockQty,
        reason: "Initial stock",
        performedBy: u.sellerId,
      });
    }

    // Audit log product creation
    logAudit({
      userId: u.sellerId,
      actionType: "product_add",
      targetId: id,
      targetType: "product",
      details: { name: input.name, basePrice: input.basePrice, stockQty: input.stockQty, addedByRole: u.role },
    });

    reply.code(201).send({ id, ...input, createdAt: ts, addedBy: u.sellerId });
  });

  app.get("/products", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z
      .object({
        search: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(100),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);
    const u = (request as any).user as { sellerId: string; role: Role } | null;
    const clauses = [];
    const params: unknown[] = [];
    if (query.search) {
      clauses.push("(name LIKE ? OR barcode LIKE ?)");
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const select =
      u?.role === "seller"
        ? "id, name, barcode, category, base_price, tax_rate, stock_qty, low_stock_alert, expiry_date, created_at, updated_at"
        : "*";
    return db
      .prepare(
        `SELECT ${select} FROM products ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset);
  });

  app.put("/products/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const input = productSchema.partial().parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };

    const original = db
      .prepare("SELECT * FROM products WHERE id = ?")
      .get(params.id) as { id: string; name: string; stock_qty: number; base_price: number } | undefined;
    if (!original) throw notFound("Product not found");

    if (input.barcode) {
      const dup = db
        .prepare("SELECT id FROM products WHERE barcode = ? AND id != ?")
        .get(input.barcode, params.id);
      if (dup) throw badRequest("Barcode already exists");
    }

    const expiryProvided = Object.prototype.hasOwnProperty.call(input, "expiryDate");
    db.prepare(
      "UPDATE products SET name = COALESCE(?, name), barcode = COALESCE(?, barcode), category = COALESCE(?, category), cost_price = COALESCE(?, cost_price), base_price = COALESCE(?, base_price), tax_rate = COALESCE(?, tax_rate), stock_qty = COALESCE(?, stock_qty), low_stock_alert = COALESCE(?, low_stock_alert), expiry_date = CASE WHEN ? = 1 THEN ? ELSE expiry_date END, updated_at = ? WHERE id = ?"
    ).run(
      input.name ?? null,
      input.barcode ?? null,
      input.category ?? null,
      input.costPrice ?? null,
      input.basePrice ?? null,
      input.taxRate ?? null,
      input.stockQty ?? null,
      input.lowStockAlert ?? null,
      expiryProvided ? 1 : 0,
      input.expiryDate ?? null,
      now(),
      params.id
    );

    // Log inventory movement if stock changed
    if (input.stockQty !== undefined && input.stockQty !== original.stock_qty) {
      const change = input.stockQty - original.stock_qty;
      logInventoryMovement({
        productId: params.id,
        movementType: "adjustment",
        quantityChange: change,
        beforeQty: original.stock_qty,
        afterQty: input.stockQty,
        reason: "Manual stock adjustment",
        performedBy: u.sellerId,
      });
    }

    // Log audit for product edit
    const changes: Record<string, any> = {};
    if (input.name !== undefined && input.name !== original.name) changes.name = { from: original.name, to: input.name };
    if (input.basePrice !== undefined && input.basePrice !== original.base_price) changes.basePrice = { from: original.base_price, to: input.basePrice };
    if (input.stockQty !== undefined && input.stockQty !== original.stock_qty) changes.stockQty = { from: original.stock_qty, to: input.stockQty };

    if (Object.keys(changes).length > 0) {
      logAudit({
        userId: u.sellerId,
        actionType: input.basePrice !== undefined && input.basePrice !== original.base_price ? "price_change" : "product_edit",
        targetId: params.id,
        targetType: "product",
        details: changes,
      });
    }

    reply.send({ id: params.id });
  });

  // ===== EDIT REQUEST SYSTEM =====
  
  // Employee creates an edit request
  app.post("/edit-requests", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const input = z.object({
      productId: z.string(),
      requestType: z.enum(["stock_adjustment", "price_change", "product_edit", "other"]),
      reason: z.string().min(1),
      requestedField: z.string().optional(),
      currentValue: z.string().optional(),
      requestedValue: z.string().optional(),
    }).parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };

    // Check product exists
    const product = db.prepare("SELECT id, name FROM products WHERE id = ?").get(input.productId);
    if (!product) throw notFound("Product not found");

    const id = nanoid();
    const ts = now();
    db.prepare(
      "INSERT INTO edit_requests (id, product_id, requested_by, request_type, reason, requested_field, current_value, requested_value, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
    ).run(id, input.productId, u.sellerId, input.requestType, input.reason, input.requestedField ?? null, input.currentValue ?? null, input.requestedValue ?? null, ts);

    // Audit log
    logAudit({
      userId: u.sellerId,
      actionType: "edit_request_created",
      targetId: id,
      targetType: "edit_request",
      details: { productId: input.productId, requestType: input.requestType, reason: input.reason },
    });

    reply.code(201).send({ id, status: "pending", createdAt: ts });
  });

  // Get all edit requests (admin sees all, employee sees own)
  app.get("/edit-requests", { preHandler: [requireAuth as any] }, async (request) => {
    const u = (request as any).user as { sellerId: string; role: Role };
    const query = z.object({
      status: z.enum(["pending", "approved", "rejected", "completed", "all"]).default("all"),
    }).parse(request.query);

    let sql = `
      SELECT er.*, p.name as product_name, s.name as requester_name
      FROM edit_requests er
      LEFT JOIN products p ON p.id = er.product_id
      LEFT JOIN sellers s ON s.id = er.requested_by
    `;
    const params: any[] = [];

    if (u.role !== "admin") {
      sql += " WHERE er.requested_by = ?";
      params.push(u.sellerId);
      if (query.status !== "all") {
        sql += " AND er.status = ?";
        params.push(query.status);
      }
    } else {
      if (query.status !== "all") {
        sql += " WHERE er.status = ?";
        params.push(query.status);
      }
    }
    sql += " ORDER BY er.created_at DESC";
    return db.prepare(sql).all(...params);
  });

  // Get pending notifications count for admin
  app.get("/notifications/count", { preHandler: [requireAuth as any] }, async (request) => {
    const u = (request as any).user as { sellerId: string; role: Role };
    if (u.role !== "admin") {
      return { count: 0 };
    }
    const result = db.prepare("SELECT COUNT(*) as cnt FROM edit_requests WHERE status = 'pending'").get() as any;
    return { count: result?.cnt ?? 0 };
  });

  // Admin approves an edit request
  app.post("/edit-requests/:id/approve", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const u = (request as any).user as { sellerId: string; role: Role };

    const req = db.prepare("SELECT * FROM edit_requests WHERE id = ?").get(params.id) as any;
    if (!req) throw notFound("Request not found");
    if (req.status !== "pending") throw badRequest("Request already processed");

    const ts = now();
    db.prepare(
      "UPDATE edit_requests SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?"
    ).run(u.sellerId, ts, params.id);

    // Audit log
    logAudit({
      userId: u.sellerId,
      actionType: "edit_request_approved",
      targetId: params.id,
      targetType: "edit_request",
      details: { productId: req.product_id, requestType: req.request_type },
    });

    reply.send({ id: params.id, status: "approved" });
  });

  // Admin rejects an edit request
  app.post("/edit-requests/:id/reject", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const u = (request as any).user as { sellerId: string; role: Role };

    const req = db.prepare("SELECT * FROM edit_requests WHERE id = ?").get(params.id) as any;
    if (!req) throw notFound("Request not found");
    if (req.status !== "pending") throw badRequest("Request already processed");

    const ts = now();
    db.prepare(
      "UPDATE edit_requests SET status = 'rejected', approved_by = ?, approved_at = ? WHERE id = ?"
    ).run(u.sellerId, ts, params.id);

    // Audit log
    logAudit({
      userId: u.sellerId,
      actionType: "edit_request_rejected",
      targetId: params.id,
      targetType: "edit_request",
      details: { productId: req.product_id, requestType: req.request_type },
    });

    reply.send({ id: params.id, status: "rejected" });
  });

  // Employee completes an approved edit (makes the actual change)
  app.post("/edit-requests/:id/complete", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const input = z.object({
      newStockQty: z.number().optional(),
      newBasePrice: z.number().optional(),
      newName: z.string().optional(),
    }).parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };

    const req = db.prepare("SELECT * FROM edit_requests WHERE id = ?").get(params.id) as any;
    if (!req) throw notFound("Request not found");
    if (req.status !== "approved") throw badRequest("Request not approved yet");
    if (req.requested_by !== u.sellerId && u.role !== "admin") {
      throw badRequest("Only the requester or admin can complete this request");
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(req.product_id) as any;
    if (!product) throw notFound("Product not found");

    const ts = now();
    const changes: Record<string, any> = {};

    // Apply the requested change based on type
    if (req.request_type === "stock_adjustment" && input.newStockQty !== undefined) {
      const change = input.newStockQty - product.stock_qty;
      db.prepare("UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?").run(input.newStockQty, ts, req.product_id);
      logInventoryMovement({
        productId: req.product_id,
        movementType: "adjustment",
        quantityChange: change,
        beforeQty: product.stock_qty,
        afterQty: input.newStockQty,
        reason: `Approved edit request: ${req.reason}`,
        performedBy: u.sellerId,
      });
      changes.stockQty = { from: product.stock_qty, to: input.newStockQty };
    }

    if (req.request_type === "price_change" && input.newBasePrice !== undefined) {
      db.prepare("UPDATE products SET base_price = ?, updated_at = ? WHERE id = ?").run(input.newBasePrice, ts, req.product_id);
      changes.basePrice = { from: product.base_price, to: input.newBasePrice };
    }

    if (req.request_type === "product_edit" && input.newName !== undefined) {
      db.prepare("UPDATE products SET name = ?, updated_at = ? WHERE id = ?").run(input.newName, ts, req.product_id);
      changes.name = { from: product.name, to: input.newName };
    }

    // Mark request as completed
    db.prepare("UPDATE edit_requests SET status = 'completed', completed_at = ? WHERE id = ?").run(ts, params.id);

    // Audit log
    logAudit({
      userId: u.sellerId,
      actionType: "edit_request_completed",
      targetId: params.id,
      targetType: "edit_request",
      details: { productId: req.product_id, changes },
    });

    reply.send({ id: params.id, status: "completed", changes });
  });

  app.post(
    "/products/import-bulk",
    { preHandler: [requireAdmin as any] },
    async (request, reply) => {
    const input = productBulkSchema.parse(request.body);
    const results: { id?: string; barcode?: string; ok: boolean; message?: string }[] = [];
    const tx = db.transaction(() => {
      for (const item of input.items) {
        try {
          if (item.barcode) {
            const dup = db.prepare("SELECT id FROM products WHERE barcode = ?").get(item.barcode);
            if (dup) throw new Error("Barcode already exists");
          }
          const id = item.id ?? nanoid();
          const ts = now();
          db.prepare(
            "INSERT INTO products (id, name, barcode, category, cost_price, base_price, tax_rate, stock_qty, low_stock_alert, expiry_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(
            id,
            item.name,
            item.barcode ?? null,
            item.category ?? null,
            item.costPrice,
            item.basePrice,
            item.taxRate,
            item.stockQty,
            item.lowStockAlert ?? null,
            item.expiryDate ?? null,
            ts,
            ts
          );
          results.push({ id, barcode: item.barcode, ok: true });
        } catch (err: any) {
          results.push({
            id: item.id,
            barcode: item.barcode,
            ok: false,
            message: err?.message,
          });
        }
      }
    });
    tx();
    reply.send({ results });
  });

  app.post("/services", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = serviceSchema.parse(request.body);
    const id = nanoid();
    const ts = now();
    db.prepare(
      "INSERT INTO services (id, name, category, cost_price, suggested_price, tax_rate, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      input.name,
      input.category ?? null,
      input.costPrice ?? 0,
      input.suggestedPrice ?? null,
      input.taxRate,
      input.notes ?? null,
      ts,
      ts
    );
    reply.code(201).send({ id, ...input, createdAt: ts });
  });

  app.get("/services", async (request) => {
    const query = z
      .object({
        search: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(100),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);
    const clauses = [];
    const params: unknown[] = [];
    if (query.search) {
      clauses.push("(name LIKE ? OR category LIKE ?)");
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT * FROM services ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset);
  });

  app.put("/services/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const input = serviceSchema.partial().parse(request.body);
    const exists = db
      .prepare("SELECT id FROM services WHERE id = ?")
      .get(params.id);
    if (!exists) throw notFound("Service not found");
    db.prepare(
      "UPDATE services SET name = COALESCE(?, name), category = COALESCE(?, category), cost_price = COALESCE(?, cost_price), suggested_price = COALESCE(?, suggested_price), tax_rate = COALESCE(?, tax_rate), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?"
    ).run(
      input.name ?? null,
      input.category ?? null,
      input.costPrice ?? null,
      input.suggestedPrice ?? null,
      input.taxRate ?? null,
      input.notes ?? null,
      now(),
      params.id
    );
    reply.send({ id: params.id });
  });

  app.post("/kpi-rules", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = kpiRuleSchema.parse(request.body);
    const id = nanoid();
    db.prepare(
      "INSERT INTO kpi_rules (id, branch_id, point_per_extra_value, points_per_service, bonus_threshold, bonus_points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      input.branchId,
      input.pointPerExtraValue,
      input.pointsPerService,
      input.bonusThreshold ?? null,
      input.bonusPoints ?? null,
      now()
    );
    reply.code(201).send({ id });
  });

  app.get("/kpi-rules", async (request) => {
    const query = z.object({ branchId: z.string().optional() }).parse(request.query);
    if (query.branchId) {
      return (
        db
          .prepare(
            "SELECT * FROM kpi_rules WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1"
          )
          .get(query.branchId) ?? null
      );
    }
    return db.prepare("SELECT * FROM kpi_rules").all();
  });

  app.post("/sales", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const input = saleSchema.parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };
    if (input.sellerId !== u.sellerId) throw forbidden("Seller mismatch");
    const saleId = nanoid();
    const createdAt = input.createdAt ?? now();
    const branch = db
      .prepare("SELECT id, tax_rate, currency FROM branches WHERE id = ?")
      .get(input.branchId) as { id: string; tax_rate: number; currency: string } | undefined;
    if (!branch) throw badRequest("Branch not found");
    const device = db
      .prepare("SELECT id FROM devices WHERE id = ? AND branch_id = ?")
      .get(input.deviceId, input.branchId);
    if (!device) throw badRequest("Device not registered to branch");
    const seller = db
      .prepare("SELECT id, name, active FROM sellers WHERE id = ?")
      .get(input.sellerId) as { id: string; name: string; active: number } | undefined;
    if (!seller) throw badRequest("Seller not found");
    if (!seller.active) throw badRequest("Seller inactive");

    const settingsRow =
      (db.prepare("SELECT loyalty_points_rate, loyalty_redeem_rate FROM settings WHERE id = 1").get() as
        | any
        | undefined) ?? { loyalty_points_rate: 0.01, loyalty_redeem_rate: 0.01 };
    const pointsRate = Number(settingsRow.loyalty_points_rate ?? 0.01);
    const redeemRate = Number(settingsRow.loyalty_redeem_rate ?? 0.01);

    let customerId: string | null = null;
    let pointsEarned = 0;
    let pointsRedeemed = 0;
    let redeemValue = 0;
    if (input.customer) {
      const phone = input.customer.phone?.trim() || null;
      const name = input.customer.name?.trim() || null;
      if (!phone && !name) throw badRequest("Customer name or phone required");
      const existing =
        (phone &&
          (db
            .prepare("SELECT id, points FROM customers WHERE phone = ?")
            .get(phone) as { id: string; points: number } | undefined)) ||
        null;
      if (existing) {
        customerId = existing.id;
      } else {
        customerId = nanoid();
        db.prepare(
          "INSERT INTO customers (id, name, phone, points, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
        ).run(customerId, name, phone, createdAt, createdAt);
      }
    }

    const receiptNo = getNextReceiptNo(db, input.branchId, input.deviceId);
    const rule = getKpiRule(db, input.branchId);
    
    // Get tax inclusion setting
    const settingsRow = db.prepare("SELECT tax_included FROM settings WHERE id = 1").get() as { tax_included: number } | undefined;
    const taxIncluded = settingsRow?.tax_included === 1;

    const tx = db.transaction(() => {
      let totalAmount = 0;
      let totalExtra = 0;
      let totalTax = 0;
      let servicesSold = 0;

      db.prepare(
        "INSERT INTO sales (id, branch_id, device_id, seller_id, seller_name, receipt_no, payment_method, payments_json, total_amount, total_extra_value, total_tax, customer_id, points_earned, points_redeemed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        saleId,
        input.branchId,
        input.deviceId,
        input.sellerId,
        seller.name,
        receiptNo,
        input.paymentMethod,
        null,
        0,
        0,
        0,
        customerId,
        0,
        0,
        createdAt
      );

      for (const item of input.items) {
        if (item.kind === "product") {
          const product = db
            .prepare(
              "SELECT id, name, base_price, tax_rate, stock_qty FROM products WHERE id = ?"
            )
            .get(item.itemId) as
            | {
                id: string;
                name: string;
                base_price: number;
                tax_rate: number;
                stock_qty: number;
              }
            | undefined;
          if (!product) throw badRequest("Product not found");
          if (item.finalPrice < product.base_price) {
            throw badRequest(
              `Final price ${item.finalPrice} below base price ${product.base_price}`
            );
          }
          if (product.stock_qty < item.quantity) {
            throw badRequest(
              `Insufficient stock for ${product.name} (have ${product.stock_qty}, need ${item.quantity})`
            );
          }
          const extraValue = (item.finalPrice - product.base_price) * item.quantity;
          const taxAmount = product.tax_rate * item.finalPrice * item.quantity;
          const lineTotal = item.finalPrice * item.quantity;
          const saleItemId = nanoid();

          // Only include tax in total if taxIncluded setting is enabled
          totalAmount += taxIncluded ? (lineTotal + taxAmount) : lineTotal;
          totalExtra += extraValue;
          totalTax += taxAmount; // Always track tax for reporting, even if not included in total

          db.prepare(
            "INSERT INTO sale_items (id, sale_id, kind, item_id, name, base_price, final_price, extra_value, quantity, tax_rate, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(
            saleItemId,
            saleId,
            "product",
            product.id,
            product.name,
            product.base_price,
            item.finalPrice,
            extraValue,
            item.quantity,
            product.tax_rate,
            taxAmount
          );

          const beforeQty = product.stock_qty;
          const afterQty = beforeQty - item.quantity;
          db.prepare(
            "UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ?"
          ).run(item.quantity, createdAt, product.id);

          // Log inventory movement for sale
          logInventoryMovement({
            productId: product.id,
            movementType: "sale",
            quantityChange: -item.quantity,
            beforeQty,
            afterQty,
            performedBy: input.sellerId,
            saleId,
          });

          db.prepare(
            "INSERT INTO extra_value_logs (id, sale_item_id, seller_id, branch_id, extra_value, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(
            nanoid(),
            saleItemId,
            input.sellerId,
            input.branchId,
            extraValue,
            createdAt
          );
        } else {
          const service = db
            .prepare("SELECT id, name, tax_rate FROM services WHERE id = ?")
            .get(item.itemId) as { id: string; name: string; tax_rate: number } | undefined;
          if (!service) throw badRequest("Service not found");
          const extraValue = item.finalPrice * item.quantity;
          const taxAmount = service.tax_rate * item.finalPrice * item.quantity;
          const lineTotal = item.finalPrice * item.quantity;
          const saleItemId = nanoid();

          // Only include tax in total if taxIncluded setting is enabled
          totalAmount += taxIncluded ? (lineTotal + taxAmount) : lineTotal;
          totalExtra += extraValue;
          totalTax += taxAmount; // Always track tax for reporting, even if not included in total
          servicesSold += item.quantity;

          db.prepare(
            "INSERT INTO sale_items (id, sale_id, kind, item_id, name, base_price, final_price, extra_value, quantity, tax_rate, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(
            saleItemId,
            saleId,
            "service",
            service.id,
            service.name,
            null,
            item.finalPrice,
            extraValue,
            item.quantity,
            service.tax_rate,
            taxAmount
          );
        }
      }

      const pay = input.payments ?? { cash: input.tendered ?? 0, till: 0, bank: 0 };
      const totalPaid = Number(pay.cash || 0) + Number(pay.till || 0) + Number(pay.bank || 0);
      if (input.customer?.redeemPoints) {
        pointsRedeemed = Math.min(Number(input.customer.redeemPoints || 0), totalPaid > 0 ? totalPaid / redeemRate : Number.MAX_SAFE_INTEGER);
        redeemValue = pointsRedeemed * redeemRate;
      }
      const totalAfterRedeem = totalAmount - redeemValue;
      if (totalAfterRedeem < 0) throw badRequest("Redeem exceeds total");

      // Payment validation:
      // - Consider loyalty redemption (totalAfterRedeem)
      // - Allow small floating point differences and rounding
      // Note: With tax_rate set to 0.0 or 0.01 where tax isn't needed, frontend and API totals will match
      const epsilon = 0.01;
      const amountDue = Number(totalAfterRedeem) - Number(totalPaid);
      if (amountDue > epsilon) {
        throw badRequest("Payment is incomplete");
      }
      pointsEarned = totalAfterRedeem * pointsRate;
      db.prepare(
        "UPDATE sales SET total_amount = ?, total_extra_value = ?, total_tax = ?, payments_json = ?, points_earned = ?, points_redeemed = ? WHERE id = ?"
      ).run(totalAfterRedeem, totalExtra, totalTax, JSON.stringify(pay), pointsEarned, pointsRedeemed, saleId);

      if (customerId) {
        const cur = db
          .prepare("SELECT points FROM customers WHERE id = ?")
          .get(customerId) as { points: number } | undefined;
        const currentPoints = Number(cur?.points ?? 0);
        const nextPoints = currentPoints + pointsEarned - pointsRedeemed;
        db.prepare("UPDATE customers SET points = ?, updated_at = ? WHERE id = ?").run(
          Math.max(0, nextPoints),
          createdAt,
          customerId
        );
        db.prepare(
          "INSERT INTO loyalty_transactions (id, customer_id, sale_id, points_earned, points_redeemed, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(nanoid(), customerId, saleId, pointsEarned, pointsRedeemed, createdAt);
      }

      const points =
        totalExtra * rule.point_per_extra_value +
        servicesSold * rule.points_per_service +
        (rule.bonus_threshold && totalExtra >= rule.bonus_threshold
          ? rule.bonus_points ?? 0
          : 0);

      db.prepare(
        "INSERT INTO kpi_points (id, sale_id, seller_id, points, extra_value, services_sold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        nanoid(),
        saleId,
        input.sellerId,
        points,
        totalExtra,
        servicesSold,
        createdAt
      );

      return { saleId, receiptNo, totalAmount, totalExtra, totalTax, points };
    });

    const result = tx();

    // Audit log the sale
    logAudit({
      userId: u.sellerId,
      actionType: "sale",
      targetId: saleId,
      targetType: "sale",
      details: {
        receiptNo: result.receiptNo,
        totalAmount: result.totalAmount,
        paymentMethod: input.paymentMethod,
        itemCount: input.items.length,
      },
    });

    reply.code(201).send({ ...result, pointsEarned, pointsRedeemed, customerId, redeemValue });
  });

  app.get("/sales", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z
      .object({
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
        branchId: z.string().optional(),
        sellerId: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(100),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);
    const u = (request as any).user as { sellerId: string; role: Role };
    const clauses = [];
    const params: unknown[] = [];
    if (query.start) {
      clauses.push("created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("created_at <= ?");
      params.push(query.end);
    }
    if (query.branchId) {
      clauses.push("branch_id = ?");
      params.push(query.branchId);
    }
    if (u.role === "seller") {
      clauses.push("seller_id = ?");
      params.push(u.sellerId);
    } else if (query.sellerId) {
      clauses.push("seller_id = ?");
      params.push(query.sellerId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sales = db
      .prepare(
        `SELECT * FROM sales ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset);
    return sales;
  });

  // Comprehensive sales export with all details
  app.get("/reports/sales-export", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z.object({
      start: z.coerce.number().optional(),
      end: z.coerce.number().optional(),
      branchId: z.string().optional(),
      sellerId: z.string().optional(),
      format: z.enum(["detailed", "summary"]).default("detailed"),
    }).parse(request.query);
    const u = (request as any).user as { sellerId: string; role: Role };

    const clauses: string[] = [];
    const params: any[] = [];

    if (query.start) {
      clauses.push("s.created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("s.created_at <= ?");
      params.push(query.end);
    }
    if (query.branchId) {
      clauses.push("s.branch_id = ?");
      params.push(query.branchId);
    }
    if (u.role === "seller") {
      clauses.push("s.seller_id = ?");
      params.push(u.sellerId);
    } else if (query.sellerId) {
      clauses.push("s.seller_id = ?");
      params.push(query.sellerId);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    if (query.format === "detailed") {
      // Get all sale items with full details
      const sql = `
        SELECT 
          si.id as item_id,
          s.receipt_no,
          s.created_at as sale_date,
          p.name as product_name,
          p.barcode,
          si.unit_price as price_sold_at,
          si.quantity,
          si.line_total,
          sel.name as cashier_name,
          b.name as branch_name,
          s.payment_method
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN products p ON p.id = si.product_id
        LEFT JOIN sellers sel ON sel.id = s.seller_id
        LEFT JOIN branches b ON b.id = s.branch_id
        ${where}
        ORDER BY s.created_at DESC
      `;
      const items = db.prepare(sql).all(...params);
      return {
        type: "product_sales",
        count: items.length,
        data: items.map((row: any) => ({
          ...row,
          sale_date: new Date(row.sale_date).toISOString(),
          sale_time: new Date(row.sale_date).toLocaleTimeString(),
        })),
      };
    } else {
      // Summary by day
      const sql = `
        SELECT 
          date(created_at/1000, 'unixepoch', 'localtime') as date,
          COUNT(*) as transaction_count,
          SUM(total_amount) as total_sales,
          SUM(tax_amount) as total_tax,
          payment_method
        FROM sales s
        ${where}
        GROUP BY date(created_at/1000, 'unixepoch', 'localtime'), payment_method
        ORDER BY date DESC
      `;
      return {
        type: "sales_summary",
        data: db.prepare(sql).all(...params),
      };
    }
  });

  // Service sales export
  app.get("/reports/service-sales-export", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z.object({
      start: z.coerce.number().optional(),
      end: z.coerce.number().optional(),
      branchId: z.string().optional(),
    }).parse(request.query);

    const clauses: string[] = [];
    const params: any[] = [];

    if (query.start) {
      clauses.push("si.created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("si.created_at <= ?");
      params.push(query.end);
    }
    if (query.branchId) {
      clauses.push("s.branch_id = ?");
      params.push(query.branchId);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    // Get services from sale_items where product_id is null (services)
    const sql = `
      SELECT 
        si.id,
        s.receipt_no,
        s.created_at as sale_date,
        si.item_name as service_type,
        si.description,
        si.unit_price as price,
        si.quantity,
        si.line_total as total,
        sel.name as cashier_name,
        b.name as branch_name
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN sellers sel ON sel.id = s.seller_id
      LEFT JOIN branches b ON b.id = s.branch_id
      ${where}
      AND si.product_id IS NULL
      ORDER BY s.created_at DESC
    `;

    const items = db.prepare(sql).all(...params);
    return {
      type: "service_sales",
      count: items.length,
      data: items.map((row: any) => ({
        ...row,
        sale_date: new Date(row.sale_date).toISOString(),
        sale_time: new Date(row.sale_date).toLocaleTimeString(),
      })),
    };
  });

  app.get("/sales/:id/receipt", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const u = (request as any).user as { sellerId: string; role: Role };
    const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(params.id) as any;
    if (!sale) throw notFound("Sale not found");
    if (u.role === "seller" && sale.seller_id !== u.sellerId) throw forbidden("Not allowed");
    const items = db
      .prepare("SELECT * FROM sale_items WHERE sale_id = ?")
      .all(params.id);
    const customer =
      sale.customer_id &&
      (db.prepare("SELECT id, name, phone, points FROM customers WHERE id = ?").get(sale.customer_id) as any);
    const settings =
      db.prepare("SELECT * FROM settings WHERE id = 1").get() ?? null;
    reply.send({ sale, items, customer, settings });
  });

  app.get("/customers/lookup", { preHandler: [requireAuth as any] }, async (request) => {
    const q = z
      .object({
        phone: z.string().optional(),
      })
      .parse(request.query);
    if (!q.phone) return null;
    const row = db
      .prepare("SELECT id, name, phone, points FROM customers WHERE phone = ?")
      .get(q.phone) as any;
    return row ?? null;
  });

  app.get("/reports/kpi", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z
      .object({
        branchId: z.string().optional(),
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
      })
      .parse(request.query);
    const u = (request as any).user as { sellerId: string; role: Role };
    const clauses = [];
    const params: unknown[] = [];
    if (query.branchId) {
      clauses.push("sales.branch_id = ?");
      params.push(query.branchId);
    }
    if (query.start) {
      clauses.push("sales.created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("sales.created_at <= ?");
      params.push(query.end);
    }
    if (u.role === "seller") {
      clauses.push("kp.seller_id = ?");
      params.push(u.sellerId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT kp.seller_id, s.name as seller_name, SUM(kp.points) as points, SUM(kp.extra_value) as extra_value, SUM(kp.services_sold) as services_sold
         FROM kpi_points kp
         JOIN sales ON sales.id = kp.sale_id
         JOIN sellers s ON s.id = kp.seller_id
         ${where}
         GROUP BY kp.seller_id, s.name
         ORDER BY points DESC`
      )
      .all(...params);
    return rows;
  });

  app.get("/reports/extra-value", { preHandler: [requireAdmin as any] }, async (request) => {
    const query = z
      .object({
        branchId: z.string().optional(),
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
      })
      .parse(request.query);
    const clauses = [];
    const params: unknown[] = [];
    if (query.branchId) {
      clauses.push("branch_id = ?");
      params.push(query.branchId);
    }
    if (query.start) {
      clauses.push("created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("created_at <= ?");
      params.push(query.end);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT seller_id, SUM(extra_value) as extra_value FROM extra_value_logs ${where} GROUP BY seller_id ORDER BY extra_value DESC`
      )
      .all(...params);
  });

  app.get(
    "/reports/sales-summary",
    { preHandler: [requireAdmin as any] },
    async (request) => {
    const query = z
      .object({
        branchId: z.string().optional(),
        sellerId: z.string().optional(),
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
      })
      .parse(request.query);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.branchId) {
      clauses.push("branch_id = ?");
      params.push(query.branchId);
    }
    if (query.sellerId) {
      clauses.push("seller_id = ?");
      params.push(query.sellerId);
    }
    if (query.start) {
      clauses.push("created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("created_at <= ?");
      params.push(query.end);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const totals = db
      .prepare(
        `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total_amount, COALESCE(SUM(total_tax), 0) as total_tax, COALESCE(SUM(total_extra_value), 0) as total_extra_value
         FROM sales ${where}`
      )
      .get(...params) as any;
    const byMethodRows = db
      .prepare(
        `SELECT payment_method, COALESCE(SUM(total_amount), 0) as total_amount, COUNT(*) as count
         FROM sales ${where}
         GROUP BY payment_method`
      )
      .all(...params) as any[];
    const byMethod: Record<string, { total_amount: number; count: number }> = {};
    for (const r of byMethodRows) {
      byMethod[String(r.payment_method)] = {
        total_amount: Number(r.total_amount ?? 0),
        count: Number(r.count ?? 0),
      };
    }
    return {
      count: Number(totals?.count ?? 0),
      totalAmount: Number(totals?.total_amount ?? 0),
      totalTax: Number(totals?.total_tax ?? 0),
      totalExtraValue: Number(totals?.total_extra_value ?? 0),
      byMethod,
    };
  });

  app.get(
    "/reports/daily-accounts",
    { preHandler: [requireAdmin as any] },
    async (request) => {
    const query = z
      .object({
        branchId: z.string().optional(),
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
      })
      .parse(request.query);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.branchId) {
      clauses.push("s.branch_id = ?");
      params.push(query.branchId);
    }
    if (query.start) {
      clauses.push("s.created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("s.created_at <= ?");
      params.push(query.end);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    // Totals by day and method come from sales table (totals are tax-inclusive in this app)
    const rows = db
      .prepare(
        `SELECT date(datetime(s.created_at/1000,'unixepoch','localtime')) as day,
                SUM(CASE WHEN s.payment_method='cash' THEN s.total_amount ELSE 0 END) as cash,
                SUM(CASE WHEN s.payment_method='till' THEN s.total_amount ELSE 0 END) as till,
                SUM(CASE WHEN s.payment_method='bank' THEN s.total_amount ELSE 0 END) as bank,
                SUM(s.total_amount) as total
         FROM sales s
         ${where}
         GROUP BY day
         ORDER BY day DESC`
      )
      .all(...params) as any[];

    // Profit by day computed from sale_items joined to products/services cost_price (tax excluded)
    const profitRows = db
      .prepare(
        `SELECT date(datetime(s.created_at/1000,'unixepoch','localtime')) as day,
                SUM(
                  CASE
                    WHEN si.kind='product' THEN (si.final_price - COALESCE(p.cost_price,0)) * si.quantity
                    ELSE (si.final_price - COALESCE(sv.cost_price,0)) * si.quantity
                  END
                ) as profit
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.item_id AND si.kind='product'
         LEFT JOIN services sv ON sv.id = si.item_id AND si.kind='service'
         ${where}
         GROUP BY day
         ORDER BY day DESC`
      )
      .all(...params) as any[];

    const profitByDay: Record<string, number> = {};
    for (const r of profitRows) profitByDay[String(r.day)] = Number(r.profit ?? 0);

    return rows.map((r) => ({
      day: r.day,
      cash: Number(r.cash ?? 0),
      till: Number(r.till ?? 0),
      bank: Number(r.bank ?? 0),
      total: Number(r.total ?? 0),
      profit: Number(profitByDay[String(r.day)] ?? 0),
    }));
  });

  app.get("/reports/analytics", { preHandler: [requireAdmin as any] }, async (request) => {
    const query = z
      .object({
        branchId: z.string().optional(),
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
        limit: z.coerce.number().min(1).max(50).default(8),
      })
      .parse(request.query);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.branchId) {
      clauses.push("s.branch_id = ?");
      params.push(query.branchId);
    }
    if (query.start) {
      clauses.push("s.created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("s.created_at <= ?");
      params.push(query.end);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const topProducts = db
      .prepare(
        `SELECT si.name as name,
                SUM(si.quantity) as qty,
                SUM(si.final_price * si.quantity) as net_amount
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         ${where} AND si.kind='product'
         GROUP BY si.name
         ORDER BY net_amount DESC
         LIMIT ?`
      )
      .all(...params, query.limit);

    const topServices = db
      .prepare(
        `SELECT si.name as name,
                SUM(si.quantity) as qty,
                SUM(si.final_price * si.quantity) as net_amount
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         ${where} AND si.kind='service'
         GROUP BY si.name
         ORDER BY net_amount DESC
         LIMIT ?`
      )
      .all(...params, query.limit);

    const topCategories = db
      .prepare(
        `SELECT COALESCE(p.category,'Uncategorized') as category,
                SUM(si.quantity) as qty,
                SUM(si.final_price * si.quantity) as net_amount
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.item_id
         ${where} AND si.kind='product'
         GROUP BY category
         ORDER BY net_amount DESC
         LIMIT ?`
      )
      .all(...params, query.limit);

    return { topProducts, topServices, topCategories };
  });

  app.get("/reports/payment-mix", { preHandler: [requireAdmin as any] }, async () => {
    const rows = db.prepare("SELECT payment_method, payments_json, total_amount FROM sales").all() as any[];
    let cash = 0,
      till = 0,
      bank = 0;
    for (const r of rows) {
      const pay = r.payments_json ? JSON.parse(r.payments_json) : null;
      if (pay) {
        cash += Number(pay.cash || 0);
        till += Number(pay.till || 0);
        bank += Number(pay.bank || 0);
      } else {
        if (r.payment_method === "cash") cash += Number(r.total_amount || 0);
        if (r.payment_method === "till") till += Number(r.total_amount || 0);
        if (r.payment_method === "bank") bank += Number(r.total_amount || 0);
      }
    }
    return { cash, till, bank, total: cash + till + bank };
  });

  app.post("/backup", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const body = z.object({ destination: z.string().optional() }).parse(request.body ?? {});
    const settings =
      (db.prepare("SELECT backup_path FROM settings WHERE id = 1").get() as any) ?? null;
    const baseDest = body.destination ?? settings?.backup_path;
    if (!baseDest) throw badRequest("No backup path configured");
    const dir = fs.statSync(baseDest, { throwIfNoEntry: false })
      ? baseDest
      : path.dirname(baseDest);
    const filename = `offline-pos-backup-${Date.now()}.sqlite`;
    const destPath = fs.statSync(baseDest, { throwIfNoEntry: false })
      ? path.join(baseDest, filename)
      : baseDest;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      fs.copyFileSync(options.dbPath, destPath);
      db.prepare(
        "INSERT INTO backup_logs (file_path, status, created_at) VALUES (?, 'success', ?)"
      ).run(destPath, now());
      reply.send({ file: destPath, status: "success" });
    } catch (err) {
      db.prepare(
        "INSERT INTO backup_logs (file_path, status, created_at) VALUES (?, 'failed', ?)"
      ).run(destPath, now());
      throw err;
    }
  });

  app.post("/returns", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const u = (request as any).user as { sellerId: string; role: Role };
    const body = z
      .object({
        productId: z.string().min(1),
        branchId: z.string().min(1),
        sellerId: z.string().min(1),
        quantity: z.coerce.number().positive(),
        reason: z.string().min(2),
        restock: z.coerce.boolean().default(true),
        customerPhone: z.string().optional(),
      })
      .parse(request.body);
    if (body.sellerId !== u.sellerId) throw forbidden("Seller mismatch");

    const product = db.prepare("SELECT id, name, stock_qty FROM products WHERE id = ?").get(body.productId) as any;
    if (!product) throw notFound("Product not found");
    const seller = db.prepare("SELECT id, name FROM sellers WHERE id = ?").get(body.sellerId) as any;
    if (!seller) throw notFound("Seller not found");
    const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(body.branchId) as any;
    if (!branch) throw notFound("Branch not found");

    const createdAt = now();
    const returnId = nanoid();

    const beforeQty = product.stock_qty;
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO returns (id, product_id, branch_id, seller_id, seller_name, quantity, reason, restock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        returnId,
        body.productId,
        body.branchId,
        body.sellerId,
        seller.name,
        body.quantity,
        body.reason,
        body.restock ? 1 : 0,
        createdAt
      );
      if (body.restock) {
        db.prepare("UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?").run(
          body.quantity,
          createdAt,
          body.productId
        );
      }
    });
    tx();

    // Log inventory movement for return (if restocked)
    if (body.restock) {
      logInventoryMovement({
        productId: body.productId,
        movementType: "return",
        quantityChange: body.quantity,
        beforeQty,
        afterQty: beforeQty + body.quantity,
        reason: body.reason,
        performedBy: body.sellerId,
      });
    }

    // Audit log the return
    logAudit({
      userId: body.sellerId,
      actionType: "return",
      targetId: returnId,
      targetType: "return",
      details: {
        productId: body.productId,
        productName: product.name,
        quantity: body.quantity,
        reason: body.reason,
        restock: body.restock,
      },
    });

    reply.code(201).send({
      returnId,
      productId: body.productId,
      productName: product.name,
      quantity: body.quantity,
      reason: body.reason,
      restock: body.restock,
      createdAt,
    });
  });

  // ===== EXPENSES MODULE =====
  
  const expenseSchema = z.object({
    description: z.string().min(1),
    category: z.string().optional(),
    amount: z.number().min(0),
    expenseDate: z.number().optional(), // timestamp, defaults to now
    branchId: z.string().optional(),
    notes: z.string().optional(),
  });

  // Create expense
  app.post("/expenses", { preHandler: [requireAuth as any] }, async (request, reply) => {
    const input = expenseSchema.parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };
    
    // Check if employee is allowed to enter expenses
    const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() as any;
    const allowEmployeeExpenses = settings?.allow_employee_expenses === 1;
    
    if (u.role !== "admin" && !allowEmployeeExpenses) {
      throw badRequest("Employees are not allowed to enter expenses");
    }
    
    const id = nanoid();
    const ts = now();
    const isEmployeeEntered = u.role !== "admin";
    const approved = u.role === "admin" ? 1 : 0; // Auto-approve admin expenses
    
    db.prepare(
      `INSERT INTO expenses (id, description, category, amount, expense_date, created_by, branch_id, employee_entered, approved, notes, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.description,
      input.category ?? null,
      input.amount,
      input.expenseDate ?? ts,
      u.sellerId,
      input.branchId ?? null,
      isEmployeeEntered ? 1 : 0,
      approved,
      input.notes ?? null,
      ts,
      ts
    );
    
    logAudit({
      userId: u.sellerId,
      actionType: "expense_created",
      targetId: id,
      targetType: "expense",
      details: { description: input.description, amount: input.amount, employeeEntered: isEmployeeEntered },
    });
    
    reply.code(201).send({ id, approved: approved === 1, createdAt: ts });
  });

  // Get expenses
  app.get("/expenses", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z.object({
      start: z.coerce.number().optional(),
      end: z.coerce.number().optional(),
      branchId: z.string().optional(),
      status: z.enum(["all", "approved", "pending"]).default("all"),
      limit: z.coerce.number().min(1).max(500).default(200),
      offset: z.coerce.number().min(0).default(0),
    }).parse(request.query);
    const u = (request as any).user as { sellerId: string; role: Role };
    
    const clauses: string[] = [];
    const params: any[] = [];
    
    if (query.start) {
      clauses.push("e.expense_date >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("e.expense_date <= ?");
      params.push(query.end);
    }
    if (query.branchId) {
      clauses.push("e.branch_id = ?");
      params.push(query.branchId);
    }
    if (query.status === "approved") {
      clauses.push("e.approved = 1");
    } else if (query.status === "pending") {
      clauses.push("e.approved = 0");
    }
    
    // Sellers only see their own expenses
    if (u.role === "seller") {
      clauses.push("e.created_by = ?");
      params.push(u.sellerId);
    }
    
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    
    const sql = `
      SELECT e.*, s.name as created_by_name, b.name as branch_name
      FROM expenses e
      LEFT JOIN sellers s ON s.id = e.created_by
      LEFT JOIN branches b ON b.id = e.branch_id
      ${where}
      ORDER BY e.expense_date DESC
      LIMIT ? OFFSET ?
    `;
    
    return db.prepare(sql).all(...params, query.limit, query.offset);
  });

  // Approve/reject expense (admin only)
  app.post("/expenses/:id/approve", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const u = (request as any).user as { sellerId: string; role: Role };
    
    const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(params.id) as any;
    if (!expense) throw notFound("Expense not found");
    
    const ts = now();
    db.prepare("UPDATE expenses SET approved = 1, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?")
      .run(u.sellerId, ts, ts, params.id);
    
    logAudit({
      userId: u.sellerId,
      actionType: "expense_approved",
      targetId: params.id,
      targetType: "expense",
      details: { description: expense.description, amount: expense.amount },
    });
    
    reply.send({ id: params.id, approved: true });
  });

  app.post("/expenses/:id/reject", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const u = (request as any).user as { sellerId: string; role: Role };
    
    const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(params.id) as any;
    if (!expense) throw notFound("Expense not found");
    
    // Delete the expense on rejection
    db.prepare("DELETE FROM expenses WHERE id = ?").run(params.id);
    
    logAudit({
      userId: u.sellerId,
      actionType: "expense_rejected",
      targetId: params.id,
      targetType: "expense",
      details: { description: expense.description, amount: expense.amount },
    });
    
    reply.send({ id: params.id, deleted: true });
  });

  // Update expense (admin only)
  app.put("/expenses/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const input = expenseSchema.partial().parse(request.body);
    const u = (request as any).user as { sellerId: string; role: Role };
    
    const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(params.id) as any;
    if (!expense) throw notFound("Expense not found");
    
    const ts = now();
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [ts];
    
    if (input.description !== undefined) {
      updates.push("description = ?");
      values.push(input.description);
    }
    if (input.category !== undefined) {
      updates.push("category = ?");
      values.push(input.category);
    }
    if (input.amount !== undefined) {
      updates.push("amount = ?");
      values.push(input.amount);
    }
    if (input.expenseDate !== undefined) {
      updates.push("expense_date = ?");
      values.push(input.expenseDate);
    }
    if (input.notes !== undefined) {
      updates.push("notes = ?");
      values.push(input.notes);
    }
    
    values.push(params.id);
    db.prepare(`UPDATE expenses SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    
    reply.send({ id: params.id });
  });

  // Delete expense (admin only)
  app.delete("/expenses/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    
    const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(params.id) as any;
    if (!expense) throw notFound("Expense not found");
    
    db.prepare("DELETE FROM expenses WHERE id = ?").run(params.id);
    
    reply.code(204).send();
  });

  // Get expense summary for net profit calculation
  app.get("/expenses/summary", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z.object({
      start: z.coerce.number().optional(),
      end: z.coerce.number().optional(),
      branchId: z.string().optional(),
      period: z.enum(["day", "week", "month", "year", "all"]).default("all"),
    }).parse(request.query);
    
    const clauses: string[] = ["approved = 1"];
    const params: any[] = [];
    
    if (query.start) {
      clauses.push("expense_date >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("expense_date <= ?");
      params.push(query.end);
    }
    if (query.branchId) {
      clauses.push("branch_id = ?");
      params.push(query.branchId);
    }
    
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    
    const total = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses ${where}`).get(...params) as any;
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM expenses ${where}`).get(...params) as any;
    
    // Category breakdown
    const byCategory = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as cnt 
      FROM expenses ${where} 
      GROUP BY category
    `).all(...params);
    
    return {
      totalExpenses: total?.total ?? 0,
      count: count?.cnt ?? 0,
      byCategory,
    };
  });

  // Toggle employee expenses setting
  app.post("/settings/allow-employee-expenses", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = z.object({ enabled: z.boolean() }).parse(request.body);
    const ts = now();
    
    db.prepare("UPDATE settings SET allow_employee_expenses = ?, updated_at = ? WHERE id = 1")
      .run(input.enabled ? 1 : 0, ts);
    
    reply.send({ allowEmployeeExpenses: input.enabled });
  });

  // Net profit endpoint
  app.get("/reports/net-profit", { preHandler: [requireAdmin as any] }, async (request) => {
    const query = z.object({
      start: z.coerce.number().optional(),
      end: z.coerce.number().optional(),
      branchId: z.string().optional(),
    }).parse(request.query);
    
    const salesClauses: string[] = [];
    const expensesClauses: string[] = ["approved = 1"];
    const salesParams: any[] = [];
    const expensesParams: any[] = [];
    
    if (query.start) {
      salesClauses.push("created_at >= ?");
      salesParams.push(query.start);
      expensesClauses.push("expense_date >= ?");
      expensesParams.push(query.start);
    }
    if (query.end) {
      salesClauses.push("created_at <= ?");
      salesParams.push(query.end);
      expensesClauses.push("expense_date <= ?");
      expensesParams.push(query.end);
    }
    if (query.branchId) {
      salesClauses.push("branch_id = ?");
      salesParams.push(query.branchId);
      expensesClauses.push("branch_id = ?");
      expensesParams.push(query.branchId);
    }
    
    const salesWhere = salesClauses.length ? `WHERE ${salesClauses.join(" AND ")}` : "";
    const expensesWhere = expensesClauses.length ? `WHERE ${expensesClauses.join(" AND ")}` : "";
    
    // Get total sales
    const totalSales = db.prepare(`SELECT COALESCE(SUM(total_amount), 0) as total FROM sales ${salesWhere}`).get(...salesParams) as any;
    const salesAmount = totalSales?.total ?? 0;
    
    // Get total expenses
    const totalExpenses = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses ${expensesWhere}`).get(...expensesParams) as any;
    const expensesAmount = totalExpenses?.total ?? 0;
    
    // Calculate Cost of Goods Sold (COGS)
    // Join sale_items with products/services to get cost_price
    // For products: use products.cost_price
    // For services: use services.cost_price (or 0 if not set)
    let cogsQuery = `
      SELECT COALESCE(SUM(
        CASE 
          WHEN si.kind = 'product' THEN p.cost_price * si.quantity
          WHEN si.kind = 'service' THEN COALESCE(s.cost_price, 0) * si.quantity
          ELSE 0
        END
      ), 0) as total_cogs
      FROM sale_items si
      LEFT JOIN products p ON si.kind = 'product' AND si.item_id = p.id
      LEFT JOIN services s ON si.kind = 'service' AND si.item_id = s.id
      INNER JOIN sales sa ON si.sale_id = sa.id
    `;
    
    const cogsClauses: string[] = [];
    const cogsParams: any[] = [];
    
    if (query.start) {
      cogsClauses.push("sa.created_at >= ?");
      cogsParams.push(query.start);
    }
    if (query.end) {
      cogsClauses.push("sa.created_at <= ?");
      cogsParams.push(query.end);
    }
    if (query.branchId) {
      cogsClauses.push("sa.branch_id = ?");
      cogsParams.push(query.branchId);
    }
    
    if (cogsClauses.length > 0) {
      cogsQuery += ` WHERE ${cogsClauses.join(" AND ")}`;
    }
    
    const totalCogs = db.prepare(cogsQuery).get(...cogsParams) as any;
    const cogsAmount = totalCogs?.total_cogs ?? 0;
    
    // Net Profit = Total Sales - COGS - Total Expenses
    const netProfit = salesAmount - cogsAmount - expensesAmount;
    
    // Profit Margin = (Net Profit / Total Sales) * 100
    const profitMargin = salesAmount > 0 ? ((netProfit / salesAmount) * 100).toFixed(2) : "0.00";
    
    return {
      totalSales: salesAmount,
      totalExpenses: expensesAmount,
      totalCogs: cogsAmount,
      netProfit,
      profitMargin,
    };
  });

  app.get("/returns", { preHandler: [requireAuth as any] }, async (request) => {
    const query = z
      .object({
        start: z.coerce.number().optional(),
        end: z.coerce.number().optional(),
        branchId: z.string().optional(),
        sellerId: z.string().optional(),
        limit: z.coerce.number().min(1).max(500).default(200),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);
    const u = (request as any).user as { sellerId: string; role: Role };
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.start) {
      clauses.push("r.created_at >= ?");
      params.push(query.start);
    }
    if (query.end) {
      clauses.push("r.created_at <= ?");
      params.push(query.end);
    }
    if (query.branchId) {
      clauses.push("r.branch_id = ?");
      params.push(query.branchId);
    }
    if (u.role === "seller") {
      clauses.push("r.seller_id = ?");
      params.push(u.sellerId);
    } else if (query.sellerId) {
      clauses.push("r.seller_id = ?");
      params.push(query.sellerId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT r.*, p.name as product_name
         FROM returns r
         JOIN products p ON p.id = r.product_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset);
  });

  // Inventory movements endpoint (admin only)
  app.get("/inventory-movements", { preHandler: [requireAdmin as any] }, async (request) => {
    const query = z
      .object({
        productId: z.string().optional(),
        limit: z.coerce.number().min(1).max(500).default(100),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.productId) {
      clauses.push("im.product_id = ?");
      params.push(query.productId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT im.*, p.name as product_name, s.name as performed_by_name
         FROM inventory_movements im
         LEFT JOIN products p ON p.id = im.product_id
         LEFT JOIN sellers s ON s.id = im.performed_by
         ${where}
         ORDER BY im.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset);
  });

  // Audit logs endpoint (admin only)
  app.get("/audit-logs", { preHandler: [requireAdmin as any] }, async (request) => {
    const query = z
      .object({
        actionType: z.string().optional(),
        userId: z.string().optional(),
        limit: z.coerce.number().min(1).max(500).default(100),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.actionType) {
      clauses.push("al.action_type = ?");
      params.push(query.actionType);
    }
    if (query.userId) {
      clauses.push("al.user_id = ?");
      params.push(query.userId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db
      .prepare(
        `SELECT al.*, s.name as user_name
         FROM audit_logs al
         LEFT JOIN sellers s ON s.id = al.user_id
         ${where}
         ORDER BY al.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, query.limit, query.offset);
  });

  app.post("/sync/export", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = exportSchema.parse(request.body ?? {});
    const exportDir = input.filePath
      ? path.dirname(input.filePath)
      : path.join(process.cwd(), "exports");
    fs.mkdirSync(exportDir, { recursive: true });
    const filePath =
      input.filePath ?? path.join(exportDir, `sync-${Date.now()}.json`);
    const payload = {
      sales: db.prepare("SELECT * FROM sales").all(),
      sale_items: db.prepare("SELECT * FROM sale_items").all(),
      kpi_points: db.prepare("SELECT * FROM kpi_points").all(),
      extra_value_logs: db.prepare("SELECT * FROM extra_value_logs").all(),
      returns: db.prepare("SELECT * FROM returns").all(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
    db.prepare(
      "INSERT INTO sync_logs (device_id, last_synced_at, direction, file_path, status, created_at) VALUES (?, ?, 'push', ?, 'success', ?)"
    ).run("local", now(), filePath, now());
    reply.send({ filePath });
  });

  app.post("/sync/import", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const input = importSchema.parse(request.body);
    if (!fs.existsSync(input.filePath)) throw badRequest("File not found");
    const raw = fs.readFileSync(input.filePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      sales: any[];
      sale_items: any[];
      kpi_points: any[];
      extra_value_logs: any[];
      returns?: any[];
    };
    const tx = db.transaction(() => {
      for (const sale of parsed.sales ?? []) {
        db.prepare(
          "INSERT OR IGNORE INTO sales (id, branch_id, device_id, seller_id, seller_name, receipt_no, payment_method, total_amount, total_extra_value, total_tax, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          sale.id,
          sale.branch_id,
          sale.device_id,
          sale.seller_id,
          sale.seller_name,
          sale.receipt_no,
          sale.payment_method,
          sale.total_amount,
          sale.total_extra_value,
          sale.total_tax,
          sale.created_at
        );
      }
      for (const item of parsed.sale_items ?? []) {
        db.prepare(
          "INSERT OR IGNORE INTO sale_items (id, sale_id, kind, item_id, name, base_price, final_price, extra_value, quantity, tax_rate, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          item.id,
          item.sale_id,
          item.kind,
          item.item_id,
          item.name,
          item.base_price,
          item.final_price,
          item.extra_value,
          item.quantity,
          item.tax_rate,
          item.tax_amount
        );
      }
      for (const kp of parsed.kpi_points ?? []) {
        db.prepare(
          "INSERT OR IGNORE INTO kpi_points (id, sale_id, seller_id, points, extra_value, services_sold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          kp.id,
          kp.sale_id,
          kp.seller_id,
          kp.points,
          kp.extra_value,
          kp.services_sold,
          kp.created_at
        );
      }
      for (const ev of parsed.extra_value_logs ?? []) {
        db.prepare(
          "INSERT OR IGNORE INTO extra_value_logs (id, sale_item_id, seller_id, branch_id, extra_value, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(
          ev.id,
          ev.sale_item_id,
          ev.seller_id,
          ev.branch_id,
          ev.extra_value,
          ev.created_at
        );
      }
      for (const r of parsed.returns ?? []) {
        db.prepare(
          "INSERT OR IGNORE INTO returns (id, product_id, branch_id, seller_id, seller_name, quantity, reason, restock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          r.id,
          r.product_id,
          r.branch_id,
          r.seller_id,
          r.seller_name,
          r.quantity,
          r.reason,
          r.restock,
          r.created_at
        );
      }
    });
    tx();
    db.prepare(
      "INSERT INTO sync_logs (device_id, last_synced_at, direction, file_path, status, created_at) VALUES (?, ?, 'pull', ?, 'success', ?)"
    ).run("local", now(), input.filePath, now());
    reply.send({ status: "ok" });
  });

  // Exponential backoff intervals (in ms): 5s, 15s, 30s, 60s, 120s
  const BACKOFF_INTERVALS = [5000, 15000, 30000, 60000, 120000];
  const MAX_RETRY_ATTEMPTS = 5;

  const getNextRetryTime = (attemptCount: number): number => {
    const interval = BACKOFF_INTERVALS[Math.min(attemptCount, BACKOFF_INTERVALS.length - 1)];
    return now() + interval;
  };

  app.get("/sync/sheets/queue", { preHandler: [requireAdmin as any] }, async () => {
    return db
      .prepare(
        "SELECT id, kind, status, error, attempt_count, next_retry_at, created_at, updated_at, last_attempt_at FROM sync_queue ORDER BY id DESC LIMIT 50"
      )
      .all();
  });

  // Get pending items that are ready to retry
  app.get("/sync/sheets/pending", { preHandler: [requireAdmin as any] }, async () => {
    const ts = now();
    return db
      .prepare(
        `SELECT id, kind, status, attempt_count, next_retry_at, created_at 
         FROM sync_queue 
         WHERE (status = 'pending' OR status = 'retrying') 
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY id ASC LIMIT 10`
      )
      .all(ts);
  });

  // Helper to get tracker info
  const getTracker = (dataType: string) => {
    return db.prepare("SELECT * FROM sync_tracker WHERE data_type = ?").get(dataType) as any;
  };

  // Helper to update tracker after sync
  const updateTracker = (dataType: string, lastId: string | null, count: number) => {
    const ts = now();
    const dateStr = new Date().toISOString().slice(0, 10);
    db.prepare(
      "UPDATE sync_tracker SET last_synced_id = ?, last_synced_at = ?, last_synced_date = ?, record_count = record_count + ?, updated_at = ? WHERE data_type = ?"
    ).run(lastId, ts, dateStr, count, ts, dataType);
  };

  // Helper to build sync payload - only NEW data since last sync
  const buildSyncPayload = (onlyNew: boolean = true) => {
    const settings = (db.prepare("SELECT * FROM settings WHERE id = 1").get() as any) ?? null;
    const sellersRows = db.prepare("SELECT id, name, role, active FROM sellers").all() as any[];
    const branchesRows = db.prepare("SELECT * FROM branches").all() as any[];
    const devicesRows = db.prepare("SELECT * FROM devices").all() as any[];

    // Get trackers
    const salesTracker = getTracker("sales");
    const saleItemsTracker = getTracker("sale_items");
    const productsTracker = getTracker("products");
    const returnsTracker = getTracker("returns");
    const inventoryTracker = getTracker("inventory_movements");
    const customersTracker = getTracker("customers");
    const expensesTracker = getTracker("expenses");

    // Fetch only NEW data since last sync
    let sales: any[];
    let saleItems: any[];
    let products: any[];
    let returnsRows: any[];
    let inventoryMovements: any[];
    let customers: any[];
    let expenses: any[];

    if (onlyNew && salesTracker?.last_synced_at) {
      sales = db.prepare("SELECT * FROM sales WHERE created_at > ? ORDER BY created_at ASC LIMIT 500").all(salesTracker.last_synced_at) as any[];
    } else {
      sales = db.prepare("SELECT * FROM sales ORDER BY created_at ASC").all() as any[];
    }

    if (onlyNew && saleItemsTracker?.last_synced_at) {
      saleItems = db.prepare("SELECT * FROM sale_items WHERE created_at > ? ORDER BY created_at ASC LIMIT 2000").all(saleItemsTracker.last_synced_at) as any[];
    } else {
      saleItems = db.prepare("SELECT * FROM sale_items ORDER BY created_at ASC").all() as any[];
    }

    // Products - always sync all (for updates)
    products = db.prepare("SELECT * FROM products").all() as any[];

    if (onlyNew && returnsTracker?.last_synced_at) {
      returnsRows = db.prepare("SELECT * FROM returns WHERE created_at > ? ORDER BY created_at ASC LIMIT 500").all(returnsTracker.last_synced_at) as any[];
    } else {
      returnsRows = db.prepare("SELECT * FROM returns ORDER BY created_at ASC").all() as any[];
    }

    if (onlyNew && inventoryTracker?.last_synced_at) {
      inventoryMovements = db.prepare("SELECT * FROM inventory_movements WHERE created_at > ? ORDER BY created_at ASC LIMIT 500").all(inventoryTracker.last_synced_at) as any[];
    } else {
      inventoryMovements = db.prepare("SELECT * FROM inventory_movements ORDER BY created_at ASC").all() as any[];
    }

    if (onlyNew && customersTracker?.last_synced_at) {
      customers = db.prepare("SELECT id, name, phone, points, created_at FROM customers WHERE created_at > ?").all(customersTracker.last_synced_at) as any[];
    } else {
      customers = db.prepare("SELECT id, name, phone, points, created_at FROM customers").all() as any[];
    }

    // Expenses
    if (onlyNew && expensesTracker?.last_synced_at) {
      expenses = db.prepare("SELECT * FROM expenses WHERE created_at > ? ORDER BY created_at ASC LIMIT 500").all(expensesTracker.last_synced_at) as any[];
    } else {
      expenses = db.prepare("SELECT * FROM expenses ORDER BY created_at ASC").all() as any[];
    }

    // Get daily accounts data
    const dailyAccountsTracker = getTracker("daily_accounts");
    let dailyAccounts: any[];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    if (onlyNew && dailyAccountsTracker?.last_synced_date) {
      // Get accounts from dates after last synced date
      dailyAccounts = db.prepare(`
        SELECT 
          date(created_at/1000, 'unixepoch', 'localtime') as day,
          SUM(total_amount) as total,
          SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END) as cash,
          SUM(CASE WHEN payment_method = 'till' THEN total_amount ELSE 0 END) as till,
          SUM(CASE WHEN payment_method = 'bank' THEN total_amount ELSE 0 END) as bank,
          COUNT(*) as transaction_count
        FROM sales 
        WHERE date(created_at/1000, 'unixepoch', 'localtime') > ?
        GROUP BY date(created_at/1000, 'unixepoch', 'localtime')
        ORDER BY day ASC
      `).all(dailyAccountsTracker.last_synced_date) as any[];
    } else {
      dailyAccounts = db.prepare(`
        SELECT 
          date(created_at/1000, 'unixepoch', 'localtime') as day,
          SUM(total_amount) as total,
          SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END) as cash,
          SUM(CASE WHEN payment_method = 'till' THEN total_amount ELSE 0 END) as till,
          SUM(CASE WHEN payment_method = 'bank' THEN total_amount ELSE 0 END) as bank,
          COUNT(*) as transaction_count
        FROM sales 
        GROUP BY date(created_at/1000, 'unixepoch', 'localtime')
        ORDER BY day ASC
      `).all() as any[];
    }

    return {
      generatedAt: now(),
      syncMode: onlyNew ? "incremental" : "full",
      sheetUrl: settings?.google_sheet_url ?? "",
      settings: {
        business_name: settings?.business_name ?? "",
        branch_count: branchesRows.length,
        device_count: devicesRows.length,
      },
      newRecords: {
        sales: sales.length,
        sale_items: saleItems.length,
        products: products.length,
        returns: returnsRows.length,
        inventory_movements: inventoryMovements.length,
        customers: customers.length,
        daily_accounts: dailyAccounts.length,
        expenses: expenses.length,
      },
      sales: sales.map((s) => ({ ...s, payments: s.payments_json ? JSON.parse(s.payments_json) : undefined })),
      sale_items: saleItems,
      products,
      returns: returnsRows,
      sellers: sellersRows,
      branches: branchesRows,
      devices: devicesRows,
      inventory_movements: inventoryMovements,
      customers,
      daily_accounts: dailyAccounts,
      expenses,
    };
  };

  // Mark data as synced after successful copy/push
  const markAsSynced = (payload: any) => {
    const ts = now();
    if (payload.sales?.length > 0) {
      const lastSale = payload.sales[payload.sales.length - 1];
      updateTracker("sales", lastSale.id, payload.sales.length);
    }
    if (payload.sale_items?.length > 0) {
      const lastItem = payload.sale_items[payload.sale_items.length - 1];
      updateTracker("sale_items", lastItem.id, payload.sale_items.length);
    }
    if (payload.products?.length > 0) {
      updateTracker("products", null, payload.products.length);
    }
    if (payload.returns?.length > 0) {
      const lastReturn = payload.returns[payload.returns.length - 1];
      updateTracker("returns", lastReturn.id, payload.returns.length);
    }
    if (payload.inventory_movements?.length > 0) {
      const lastMove = payload.inventory_movements[payload.inventory_movements.length - 1];
      updateTracker("inventory_movements", lastMove.id, payload.inventory_movements.length);
    }
    if (payload.customers?.length > 0) {
      const lastCust = payload.customers[payload.customers.length - 1];
      updateTracker("customers", lastCust.id, payload.customers.length);
    }
    if (payload.daily_accounts?.length > 0) {
      const lastDay = payload.daily_accounts[payload.daily_accounts.length - 1];
      db.prepare(
        "UPDATE sync_tracker SET last_synced_date = ?, last_synced_at = ?, record_count = record_count + ?, updated_at = ? WHERE data_type = ?"
      ).run(lastDay.day, ts, payload.daily_accounts.length, ts, "daily_accounts");
    }
    if (payload.expenses?.length > 0) {
      const lastExpense = payload.expenses[payload.expenses.length - 1];
      updateTracker("expenses", lastExpense.id, payload.expenses.length);
    }
  };

  // Get sync status
  app.get("/sync/status", { preHandler: [requireAdmin as any] }, async () => {
    const trackers = db.prepare("SELECT * FROM sync_tracker ORDER BY data_type").all() as any[];
    const totalSales = (db.prepare("SELECT COUNT(*) as cnt FROM sales").get() as any)?.cnt ?? 0;
    const totalProducts = (db.prepare("SELECT COUNT(*) as cnt FROM products").get() as any)?.cnt ?? 0;
    const totalInventory = (db.prepare("SELECT COUNT(*) as cnt FROM inventory_movements").get() as any)?.cnt ?? 0;
    const totalCustomers = (db.prepare("SELECT COUNT(*) as cnt FROM customers").get() as any)?.cnt ?? 0;
    const totalExpenses = (db.prepare("SELECT COUNT(*) as cnt FROM expenses").get() as any)?.cnt ?? 0;

    return {
      trackers,
      totals: {
        sales: totalSales,
        products: totalProducts,
        inventory_movements: totalInventory,
        customers: totalCustomers,
        expenses: totalExpenses,
      },
    };
  });

  // Get sync data for manual copy/paste - only NEW data
  app.get("/sync/export-data", { preHandler: [requireAdmin as any] }, async () => {
    return buildSyncPayload(true); // Only new data
  });

  // Get ALL data (full export)
  app.get("/sync/export-all", { preHandler: [requireAdmin as any] }, async () => {
    return buildSyncPayload(false); // All data
  });

  // Mark as synced after manual copy
  app.post("/sync/mark-synced", { preHandler: [requireAdmin as any] }, async (request) => {
    const payload = buildSyncPayload(true);
    markAsSynced(payload);
    return { success: true, message: "Data marked as synced", recordsMarked: payload.newRecords };
  });

  // Reset sync tracker (to re-sync everything)
  app.post("/sync/reset-tracker", { preHandler: [requireAdmin as any] }, async () => {
    const ts = now();
    db.prepare("UPDATE sync_tracker SET last_synced_id = NULL, last_synced_at = NULL, last_synced_date = NULL, record_count = 0, updated_at = ?").run(ts);
    return { success: true, message: "Sync tracker reset. Next export will include all data." };
  });

  app.post("/sync/sheets/push", { preHandler: [requireAdmin as any] }, async () => {
    const settings =
      (db.prepare("SELECT * FROM settings WHERE id = 1").get() as any) ?? null;
    if (!settings?.google_sheet_url) throw badRequest("Google Sheet URL is not set in settings");

    const payload = buildSyncPayload(true); // Only new data
    const ts = now();

    // Check if there's new data to sync
    const totalNew = Object.values(payload.newRecords as Record<string, number>).reduce((a, b) => a + b, 0);
    if (totalNew === 0) {
      return { status: "success", message: "No new data to sync", newRecords: payload.newRecords };
    }
    
    // Insert into queue as pending
    const info = db
      .prepare(
        "INSERT INTO sync_queue (kind, payload_json, status, error, attempt_count, next_retry_at, created_at, updated_at, last_attempt_at) VALUES (?, ?, 'pending', NULL, 0, NULL, ?, ?, ?)"
      )
      .run("sheets-push", JSON.stringify(payload), ts, ts, ts);

    // Try to actually push to Google Sheets
    try {
      const response = await fetch(settings.google_sheet_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        db.prepare(
          "UPDATE sync_queue SET status = 'success', attempt_count = 1, updated_at = ?, last_attempt_at = ? WHERE id = ?"
        ).run(now(), now(), info.lastInsertRowid);
        // Mark data as synced to avoid duplicates
        markAsSynced(payload);
        return { id: info.lastInsertRowid, status: "success", queuedAt: ts, attemptCount: 1, message: "Data sent to Google Sheets", newRecords: payload.newRecords };
      } else {
        const errText = await response.text().catch(() => "Unknown error");
        db.prepare(
          "UPDATE sync_queue SET status = 'failed', error = ?, attempt_count = 1, updated_at = ?, last_attempt_at = ? WHERE id = ?"
        ).run(`HTTP ${response.status}: ${errText.slice(0, 200)}`, now(), now(), info.lastInsertRowid);
        return { id: info.lastInsertRowid, status: "failed", error: `HTTP ${response.status}`, queuedAt: ts, attemptCount: 1 };
      }
    } catch (err: any) {
      // Network error - mark as pending for retry
      db.prepare(
        "UPDATE sync_queue SET status = 'pending', error = ?, attempt_count = 1, next_retry_at = ?, updated_at = ?, last_attempt_at = ? WHERE id = ?"
      ).run(err?.message ?? "Network error", now() + 30000, now(), now(), info.lastInsertRowid);
      return { id: info.lastInsertRowid, status: "pending", error: err?.message ?? "Network error - will retry", queuedAt: ts, attemptCount: 1 };
    }
  });

  // Retry a specific sync queue item
  app.post("/sync/sheets/retry/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const item = db.prepare("SELECT * FROM sync_queue WHERE id = ?").get(params.id) as any;
    if (!item) throw notFound("Queue item not found");
    if (item.status === "success") throw badRequest("Item already synced successfully");

    const ts = now();
    const newAttemptCount = (item.attempt_count ?? 0) + 1;

    if (newAttemptCount > MAX_RETRY_ATTEMPTS) {
      // Mark as permanently failed after max retries
      db.prepare(
        "UPDATE sync_queue SET status = 'failed', error = ?, attempt_count = ?, updated_at = ?, last_attempt_at = ? WHERE id = ?"
      ).run("Max retry attempts exceeded", newAttemptCount, ts, ts, params.id);
      return { id: params.id, status: "failed", error: "Max retry attempts exceeded", attemptCount: newAttemptCount };
    }

    // Simulate push attempt (in real implementation, this would call Google Sheets API)
    // For now, simulate success
    db.prepare(
      "UPDATE sync_queue SET status = 'success', error = NULL, attempt_count = ?, updated_at = ?, last_attempt_at = ? WHERE id = ?"
    ).run(newAttemptCount, ts, ts, params.id);

    return { id: params.id, status: "success", attemptCount: newAttemptCount };
  });

  // Mark a sync item for retry with backoff
  app.post("/sync/sheets/schedule-retry/:id", { preHandler: [requireAdmin as any] }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const item = db.prepare("SELECT * FROM sync_queue WHERE id = ?").get(params.id) as any;
    if (!item) throw notFound("Queue item not found");
    if (item.status === "success") throw badRequest("Item already synced successfully");

    const ts = now();
    const newAttemptCount = (item.attempt_count ?? 0) + 1;

    if (newAttemptCount > MAX_RETRY_ATTEMPTS) {
      db.prepare(
        "UPDATE sync_queue SET status = 'failed', error = ?, attempt_count = ?, updated_at = ?, last_attempt_at = ? WHERE id = ?"
      ).run("Max retry attempts exceeded", newAttemptCount, ts, ts, params.id);
      return { id: params.id, status: "failed", nextRetryAt: null };
    }

    const nextRetryAt = getNextRetryTime(newAttemptCount - 1);
    db.prepare(
      "UPDATE sync_queue SET status = 'retrying', attempt_count = ?, next_retry_at = ?, updated_at = ?, last_attempt_at = ? WHERE id = ?"
    ).run(newAttemptCount, nextRetryAt, ts, ts, params.id);

    return { id: params.id, status: "retrying", attemptCount: newAttemptCount, nextRetryAt };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({ message: "Validation failed", issues: error.issues });
      return;
    }
    const status = error.statusCode ?? 500;
    reply.code(status).send({ message: error.message });
  });

  return app;
};

