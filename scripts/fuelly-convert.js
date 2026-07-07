'use strict';
// Convert Fuelly (Gas Cubby) CSV exports into a GasTracker import file.
//
// Usage:
//   node scripts/fuelly-convert.js <fuelups.csv|services.csv> [...more csvs] > import.json
//
// Then in the app: menu → Import Backup and choose the generated file.
// Vehicles are created automatically from the car_name column; fuelup and
// service CSVs for the same car_name are merged onto one vehicle.
const fs = require('node:fs');

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  const headers = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const numOr = (v) => v === '' || v == null ? null : Number(v);

// Prefer the precise logged timestamp when it falls on the entry's date;
// otherwise pin to noon of the entry's date.
function bestDate(dateStr, addedStr) {
  if (addedStr && dateStr && addedStr.startsWith(dateStr)) return addedStr.replace(' ', 'T');
  return dateStr ? `${dateStr}T12:00:00` : (addedStr || '').replace(' ', 'T');
}

const SERVICE_NAMES = {
  engine_oil: 'Engine Oil', oil_filter: 'Oil Filter', tire_rotation: 'Tire Rotation',
  air_filter: 'Engine Air Filter', 'a/c_filter': 'Cabin Air Filter',
  wheel_alignment: 'Alignment', differential_fluid: 'Differential Fluid',
  transmission_fluid: 'Transmission Fluid', tires: 'New Tires',
  brakes_front: 'Front Brakes', brakes_rear: 'Rear Brakes',
  power_steering_fluid: 'Power Steering Fluid', steering_system: 'Steering System',
  suspension_system: 'Suspension System', clutch_fluid: 'Clutch Fluid',
  inspection: 'Inspection', battery: 'Battery', spark_plugs: 'Spark Plugs',
  coolant: 'Coolant Flush', brake_fluid: 'Brake Fluid', wipers: 'Wiper Blades',
};
const serviceName = (s) => SERVICE_NAMES[s.trim().toLowerCase()] || SERVICE_NAMES[s.trim()] || s.trim();

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/fuelly-convert.js <csv> [...more csvs] > import.json');
  process.exit(1);
}

const vehiclesByName = new Map();
let vid = 0, fid = 0, sid = 0, nid = 0;
const out = { app: 'gastracker', version: 1, vehicles: [], fuelups: [], services: [], notes: [], reminders: [], photos: [] };

function vehicleFor(name, model) {
  if (!vehiclesByName.has(name)) {
    // model column looks like "Honda Civic" / "Jeep Wrangler JL" → make + model
    const [make, ...rest] = String(model || '').split(' ');
    const v = {
      id: ++vid, name,
      make: make || '', model: rest.join(' '),
      distance_unit: 'mi', fuel_unit: 'gal', fuel_tracking: 'odometer',
      track_city_hwy: 0, country: 'United States',
    };
    vehiclesByName.set(name, v);
    out.vehicles.push(v);
  }
  return vehiclesByName.get(name);
}

for (const file of files) {
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  if (!rows.length) continue;
  const isFuelups = 'fuelup_date' in rows[0];

  for (const r of rows) {
    const v = vehicleFor(r.car_name || 'My Vehicle', r.model);
    if (isFuelups) {
      const gallons = numOr(r.gallons);
      const cpg = numOr(r.price);
      const cityPct = numOr(r.city_percentage);
      if (cityPct != null) v.track_city_hwy = 1;
      out.fuelups.push({
        id: ++fid, vehicle_id: v.id,
        date: bestDate(r.fuelup_date, r.date_added),
        odometer: numOr(r.odometer),
        gallons, cost_per_gal: cpg,
        total_cost: gallons != null && cpg != null ? Math.round(gallons * cpg * 100) / 100 : null,
        partial: r.partial_fuelup === '1' ? 1 : 0,
        missed: r.missed_fuelup === '1' ? 1 : 0,
        city_pct: cityPct,
        location: r.brand || '',
        notes: r.notes || '',
        fuel_type: '', payment: '',
      });
    } else {
      const date = bestDate(r.service_date, r.date_added);
      if (r.service_type === 'service') {
        out.services.push({
          id: ++sid, vehicle_id: v.id, date,
          odometer: numOr(r.odometer),
          total_cost: numOr(r.price),
          services: (r.sub_service_types || '').split(',').map(serviceName).filter(Boolean),
          tags: (r.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
          notes: r.notes || '', location: '', payment: '',
        });
      } else {
        // 'note' / 'bought' rows become notes
        const price = numOr(r.price);
        const bought = r.service_type === 'bought';
        out.notes.push({
          id: ++nid, vehicle_id: v.id, date,
          title: bought ? `Bought the ${v.name}` : (r.notes || 'Note'),
          text: [r.notes && !bought ? '' : r.notes,
            bought && price ? `Purchase price: $${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '',
            numOr(r.odometer) != null ? `Odometer: ${r.odometer}` : '']
            .filter(Boolean).join('\n'),
        });
      }
    }
  }
}

// summary to stderr so stdout stays clean JSON
for (const v of out.vehicles) {
  const f = out.fuelups.filter((x) => x.vehicle_id === v.id);
  const s = out.services.filter((x) => x.vehicle_id === v.id);
  const gal = f.reduce((a, x) => a + (x.gallons || 0), 0);
  const cost = f.reduce((a, x) => a + (x.total_cost || 0), 0);
  console.error(`${v.name}: ${f.length} fuelups (${gal.toFixed(1)} gal, $${cost.toFixed(2)}), ${s.length} services, ${out.notes.filter((n) => n.vehicle_id === v.id).length} notes`);
}
console.log(JSON.stringify(out, null, 1));
