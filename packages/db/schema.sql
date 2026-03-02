PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  tax_rate REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','seller')),
  pin TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE products (
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
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  suggested_price REAL,
  tax_rate REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  seller_name TEXT NOT NULL,
  receipt_no INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  total_amount REAL NOT NULL,
  total_extra_value REAL NOT NULL DEFAULT 0,
  total_tax REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('product','service')),
  item_id TEXT NOT NULL,         -- product.id or service.id
  name TEXT NOT NULL,
  base_price REAL,               -- null for services
  final_price REAL NOT NULL,
  extra_value REAL NOT NULL DEFAULT 0,
  quantity REAL NOT NULL DEFAULT 1,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE kpi_rules (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  point_per_extra_value REAL NOT NULL DEFAULT 0.1, -- e.g. 1pt per 10 KES
  points_per_service REAL NOT NULL DEFAULT 0,
  bonus_threshold REAL DEFAULT NULL,
  bonus_points REAL DEFAULT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE kpi_points (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  points REAL NOT NULL,
  extra_value REAL NOT NULL,
  services_sold INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE extra_value_logs (
  id TEXT PRIMARY KEY,
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  extra_value REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  last_synced_at INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('push','pull')),
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','success','failed')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL,
  logo_path TEXT,
  currency TEXT NOT NULL DEFAULT 'KES',
  tax_rate REAL NOT NULL DEFAULT 0,
  receipt_header TEXT,
  receipt_footer TEXT,
  backup_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  created_at INTEGER NOT NULL
);

