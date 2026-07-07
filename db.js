'use strict';
// SQLite schema + connection using Node's built-in node:sqlite (zero dependencies).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.GASTRACKER_DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'gastracker.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  year INTEGER,
  make TEXT DEFAULT '',
  model TEXT DEFAULT '',
  vin TEXT DEFAULT '',
  engine TEXT DEFAULT '',
  transmission TEXT DEFAULT '',
  license_plate TEXT DEFAULT '',
  insurance_policy TEXT DEFAULT '',
  tire_size TEXT DEFAULT '',
  tire_pressure TEXT DEFAULT '',
  country TEXT DEFAULT 'United States',
  distance_unit TEXT DEFAULT 'mi',      -- 'mi' | 'km'
  fuel_unit TEXT DEFAULT 'gal',         -- 'gal' | 'L'
  fuel_tracking TEXT DEFAULT 'odometer',-- 'odometer' | 'trip'
  track_city_hwy INTEGER DEFAULT 1,
  notes TEXT DEFAULT '',
  retired INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fuelups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  odometer REAL,
  gallons REAL,
  cost_per_gal REAL,
  total_cost REAL,
  partial INTEGER DEFAULT 0,
  missed INTEGER DEFAULT 0,
  city_pct INTEGER,
  fuel_type TEXT DEFAULT '',
  location TEXT DEFAULT '',
  payment TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuelups_vehicle ON fuelups(vehicle_id, date);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  odometer REAL,
  total_cost REAL,
  services TEXT DEFAULT '[]',   -- JSON array of service names
  location TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',       -- JSON array of tags
  payment TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_services_vehicle ON services(vehicle_id, date);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  title TEXT DEFAULT '',
  text TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_vehicle ON notes(vehicle_id, date);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TEXT,
  due_odometer REAL,
  repeat_months INTEGER,
  repeat_distance REAL,
  notes TEXT DEFAULT '',
  done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_vehicle ON reminders(vehicle_id);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,   -- 'vehicle' | 'fuelup' | 'service' | 'note'
  entity_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'photo',   -- 'photo' | 'receipt' | 'insurance_card'
  filename TEXT NOT NULL,
  original_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_entity ON photos(entity_type, entity_id);
`);

module.exports = { db, DATA_DIR, UPLOADS_DIR };
