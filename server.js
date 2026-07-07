'use strict';
// GasTracker — zero-dependency personal fuel & service tracker.
// Node >= 22 required (uses built-in node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, UPLOADS_DIR } = require('./db.js');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.GASTRACKER_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 30 * 1024 * 1024; // 30 MB (photos are sent base64-encoded)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.heic': 'image/heic',
};

// Column whitelists: everything the client may set on each table.
const COLS = {
  vehicles: ['name', 'year', 'make', 'model', 'vin', 'engine', 'transmission',
    'license_plate', 'insurance_policy', 'tire_size', 'tire_pressure', 'country',
    'distance_unit', 'fuel_unit', 'fuel_tracking', 'track_city_hwy', 'notes', 'retired'],
  fuelups: ['vehicle_id', 'date', 'odometer', 'gallons', 'cost_per_gal', 'total_cost',
    'partial', 'missed', 'city_pct', 'fuel_type', 'location', 'payment', 'notes'],
  services: ['vehicle_id', 'date', 'odometer', 'total_cost', 'services', 'location',
    'tags', 'payment', 'notes'],
  notes: ['vehicle_id', 'date', 'title', 'text', 'tags'],
  reminders: ['vehicle_id', 'title', 'due_date', 'due_odometer', 'repeat_months',
    'repeat_distance', 'notes', 'done'],
};
const TABLES = Object.keys(COLS);

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pick(table, body) {
  const out = {};
  for (const col of COLS[table]) {
    if (body[col] !== undefined) {
      let v = body[col];
      if (Array.isArray(v) || (v && typeof v === 'object')) v = JSON.stringify(v);
      if (typeof v === 'boolean') v = v ? 1 : 0;
      out[col] = v;
    }
  }
  return out;
}

function insertRow(table, data) {
  const cols = Object.keys(data);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const info = stmt.run(...cols.map((c) => data[c]));
  return getRow(table, info.lastInsertRowid);
}

function updateRow(table, id, data) {
  const cols = Object.keys(data);
  if (cols.length) {
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => data[c]), id);
  }
  return getRow(table, id);
}

function getRow(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}

function deletePhotosFor(entityType, entityId) {
  const rows = db.prepare('SELECT * FROM photos WHERE entity_type = ? AND entity_id = ?')
    .all(entityType, entityId);
  for (const p of rows) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, p.filename)); } catch {}
  }
  db.prepare('DELETE FROM photos WHERE entity_type = ? AND entity_id = ?')
    .run(entityType, entityId);
}

function entityTypeFor(table) {
  return { vehicles: 'vehicle', fuelups: 'fuelup', services: 'service', notes: 'note' }[table];
}

function savePhoto(body) {
  const { entity_type, entity_id, kind, name, data } = body;
  if (!['vehicle', 'fuelup', 'service', 'note'].includes(entity_type)) throw new Error('bad entity_type');
  if (!Number.isInteger(entity_id)) throw new Error('bad entity_id');
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(data || ''));
  if (!m) throw new Error('data must be a base64 data: URI');
  const buf = Buffer.from(m[2], 'base64');
  const extFromMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/heic': '.heic', 'application/pdf': '.pdf' }[m[1]];
  const ext = extFromMime || path.extname(String(name || '')).toLowerCase() || '.bin';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return insertRow('photos', {
    entity_type, entity_id,
    kind: ['photo', 'receipt', 'insurance_card'].includes(kind) ? kind : 'photo',
    filename, original_name: String(name || ''),
  });
}

function exportAll() {
  const dump = { app: 'gastracker', version: 1, exported_at: new Date().toISOString() };
  for (const t of [...TABLES, 'photos']) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return dump;
}

function importAll(dump) {
  if (!dump || dump.app !== 'gastracker') throw new Error('not a gastracker export');
  const counts = {};
  db.exec('BEGIN');
  try {
    // Photos are keyed by old entity ids, so remap ids as we insert.
    const idMap = { vehicles: {}, fuelups: {}, services: {}, notes: {}, reminders: {} };
    for (const t of TABLES) {
      counts[t] = 0;
      for (const row of dump[t] || []) {
        const data = pick(t, row);
        if (t !== 'vehicles' && data.vehicle_id !== undefined) {
          data.vehicle_id = idMap.vehicles[row.vehicle_id] ?? data.vehicle_id;
        }
        const created = insertRow(t, data);
        idMap[t][row.id] = created.id;
        counts[t]++;
      }
    }
    counts.photos = 0;
    const tableForType = { vehicle: 'vehicles', fuelup: 'fuelups', service: 'services', note: 'notes' };
    for (const p of dump.photos || []) {
      const map = idMap[tableForType[p.entity_type]];
      const newId = map && map[p.entity_id];
      if (!newId) continue;
      if (!fs.existsSync(path.join(UPLOADS_DIR, p.filename))) continue; // file not present on this host
      insertRow('photos', {
        entity_type: p.entity_type, entity_id: newId,
        kind: p.kind, filename: p.filename, original_name: p.original_name || '',
      });
      counts.photos++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}

function checkAuth(req, res) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass.length === PASSWORD.length &&
        crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(PASSWORD))) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GasTracker"' });
  res.end('Authentication required');
  return false;
}

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': filePath.includes(UPLOADS_DIR) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', table, id?]
  const table = parts[1];
  const id = parts[2] !== undefined ? Number(parts[2]) : null;
  const url = new URL(req.url, 'http://x');
  const method = req.method;

  if (table === 'export' && method === 'GET') {
    const body = JSON.stringify(exportAll(), null, 1);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gastracker-export-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    res.end(body);
    return;
  }
  if (table === 'import' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    json(res, 200, importAll(body));
    return;
  }

  if (table === 'photos') {
    if (method === 'GET') {
      const et = url.searchParams.get('entity_type');
      const eid = Number(url.searchParams.get('entity_id'));
      json(res, 200, db.prepare(
        'SELECT * FROM photos WHERE entity_type = ? AND entity_id = ? ORDER BY id').all(et, eid));
    } else if (method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      json(res, 201, savePhoto(body));
    } else if (method === 'DELETE' && id) {
      const p = getRow('photos', id);
      if (p) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, p.filename)); } catch {}
        db.prepare('DELETE FROM photos WHERE id = ?').run(id);
      }
      json(res, 200, { ok: true });
    } else {
      json(res, 405, { error: 'method not allowed' });
    }
    return;
  }

  if (!TABLES.includes(table)) { json(res, 404, { error: 'unknown resource' }); return; }

  if (method === 'GET' && id === null) {
    const vehicleId = Number(url.searchParams.get('vehicle_id'));
    let rows;
    const orderCol = table === 'reminders' ? 'due_date' : 'date';
    if (table === 'vehicles') {
      rows = db.prepare('SELECT * FROM vehicles ORDER BY retired, id').all();
    } else if (vehicleId) {
      rows = db.prepare(`SELECT * FROM ${table} WHERE vehicle_id = ? ORDER BY ${orderCol} DESC, id DESC`)
        .all(vehicleId);
    } else {
      rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderCol} DESC, id DESC`).all();
    }
    json(res, 200, rows);
  } else if (method === 'GET') {
    const row = getRow(table, id);
    row ? json(res, 200, row) : json(res, 404, { error: 'not found' });
  } else if (method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    json(res, 201, insertRow(table, pick(table, body)));
  } else if (method === 'PUT' && id) {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (!getRow(table, id)) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, updateRow(table, id, pick(table, body)));
  } else if (method === 'DELETE' && id) {
    if (table === 'vehicles') {
      // Cascade removes child rows; clean their photo files first.
      for (const [child, et] of [['fuelups', 'fuelup'], ['services', 'service'], ['notes', 'note']]) {
        const kids = db.prepare(`SELECT id FROM ${child} WHERE vehicle_id = ?`).all(id);
        for (const k of kids) deletePhotosFor(et, k.id);
      }
      deletePhotosFor('vehicle', id);
    } else if (entityTypeFor(table)) {
      deletePhotosFor(entityTypeFor(table), id);
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    json(res, 200, { ok: true });
  } else {
    json(res, 405, { error: 'method not allowed' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!checkAuth(req, res)) return;
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (pathname.startsWith('/uploads/')) {
      const file = path.normalize(path.join(UPLOADS_DIR, pathname.slice('/uploads/'.length)));
      if (!file.startsWith(UPLOADS_DIR)) { res.writeHead(403); res.end(); return; }
      serveStatic(res, file);
      return;
    }
    let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file)) file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
    serveStatic(res, file);
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GasTracker running at http://${HOST}:${PORT}`);
  if (PASSWORD) console.log('Password protection: ON');
});
