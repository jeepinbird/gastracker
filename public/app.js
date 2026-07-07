'use strict';
/* GasTracker SPA — vanilla JS, no dependencies. */

// ---------------------------------------------------------------- utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => escMap[c]);

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

const money = (v, dp = 2) => v == null || isNaN(v) ? '--'
  : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const num = (v, dp = 1) => v == null || isNaN(v) ? '--'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDate = (iso) => iso ? dateFmt.format(new Date(iso)) : '--';
function nowLocalISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function toLocalInput(iso) {
  if (!iso) return nowLocalISO();
  const d = new Date(iso);
  if (isNaN(d)) return nowLocalISO();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b);
const PUT = (u, b) => api('PUT', u, b);
const DEL = (u) => api('DELETE', u);

const store = {
  get: (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ---------------------------------------------------------------- state
const S = {
  vehicles: [],
  vehicle: null,          // active vehicle object
  fuelups: [], services: [], notes: [], reminders: [],
  vehiclePhotos: [],
  route: 'vehicle',
  search: '',
  typeFilter: store.get('typeFilter', { fuelup: true, service: true, note: true, reminder: true }),
};

function units(v = S.vehicle) {
  const mi = (v?.distance_unit || 'mi') === 'mi';
  const gal = (v?.fuel_unit || 'gal') === 'gal';
  return {
    dist: mi ? 'mi' : 'km',
    distLong: mi ? 'Miles' : 'Kilometers',
    fuel: gal ? 'gal' : 'L',
    fuelLong: gal ? 'Gallons' : 'Liters',
    eff: mi && gal ? 'MPG' : (!mi && !gal ? 'km/L' : (mi ? 'mi/L' : 'km/gal')),
  };
}

async function loadVehicles() {
  S.vehicles = await GET('/api/vehicles');
  const savedId = store.get('activeVehicleId', null);
  S.vehicle = S.vehicles.find((v) => v.id === savedId && !v.retired)
    || S.vehicles.find((v) => !v.retired)
    || S.vehicles[0] || null;
  if (S.vehicle) store.set('activeVehicleId', S.vehicle.id);
}

async function loadVehicleData() {
  if (!S.vehicle) { S.fuelups = S.services = S.notes = S.reminders = S.vehiclePhotos = []; return; }
  const id = S.vehicle.id;
  [S.fuelups, S.services, S.notes, S.reminders, S.vehiclePhotos] = await Promise.all([
    GET(`/api/fuelups?vehicle_id=${id}`),
    GET(`/api/services?vehicle_id=${id}`),
    GET(`/api/notes?vehicle_id=${id}`),
    GET(`/api/reminders?vehicle_id=${id}`),
    GET(`/api/photos?entity_type=vehicle&entity_id=${id}`),
  ]);
}

async function refresh() {
  await loadVehicleData();
  render();
}

// ---------------------------------------------------------------- fuel math
// Standard fuel-economy rules: a full fuel-up measures distance since the last
// full fuel-up divided by all fuel added since then (including partials).
// A "missed" fuel-up resets the calculation baseline.
function computeFuel() {
  const asc = [...S.fuelups].sort((a, b) =>
    (a.odometer ?? Infinity) === (b.odometer ?? Infinity)
      ? String(a.date).localeCompare(String(b.date))
      : (a.odometer ?? Infinity) - (b.odometer ?? Infinity));

  const mpgById = {};
  let baseline = null, accGal = 0;
  let validDist = 0, validGal = 0;
  const mpgSeries = [];

  for (const f of asc) {
    let mpg = null;
    if (f.missed) {
      accGal = 0;
      baseline = f.partial ? null : (f.odometer ?? null);
    } else if (f.partial) {
      accGal += f.gallons || 0;
    } else {
      if (baseline != null && f.odometer != null && (f.gallons || 0) > 0) {
        const dist = f.odometer - baseline;
        const gal = (f.gallons || 0) + accGal;
        if (dist > 0 && gal > 0) {
          mpg = dist / gal;
          validDist += dist;
          validGal += gal;
        }
      }
      accGal = 0;
      if (f.odometer != null) baseline = f.odometer;
    }
    mpgById[f.id] = mpg;
    if (mpg != null) mpgSeries.push({ date: f.date, v: mpg });
  }

  const odos = [...S.fuelups, ...S.services].map((r) => r.odometer).filter((o) => o != null && o > 0);
  const withCost = S.fuelups.filter((f) => f.total_cost != null);
  const totalFuelCost = withCost.reduce((s, f) => s + f.total_cost, 0);
  const totalGallons = S.fuelups.reduce((s, f) => s + (f.gallons || 0), 0);
  const cityVals = S.fuelups.map((f) => f.city_pct).filter((c) => c != null);
  const totalServiceCost = S.services.reduce((s, r) => s + (r.total_cost || 0), 0);
  const mpgVals = mpgSeries.map((p) => p.v);
  const milesTracked = odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : 0;

  return {
    mpgById, mpgSeries,
    avgMpg: validGal > 0 ? validDist / validGal : null,
    lastMpg: mpgVals.length ? mpgVals[mpgVals.length - 1] : null,
    bestMpg: mpgVals.length ? Math.max(...mpgVals) : null,
    milesTracked,
    fuelCount: S.fuelups.length,
    totalFuelCost, totalGallons,
    serviceCount: S.services.length,
    totalServiceCost,
    cityPct: cityVals.length ? Math.round(cityVals.reduce((a, b) => a + b, 0) / cityVals.length) : null,
    avgPricePerGal: totalGallons > 0 ? totalFuelCost / totalGallons : null,
    avgFuelupCost: withCost.length ? totalFuelCost / withCost.length : null,
    avgPricePerMile: milesTracked > 0 ? totalFuelCost / milesTracked : null,
    costSeries: [...S.fuelups].filter((f) => f.total_cost != null)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((f) => ({ date: f.date, v: f.total_cost })),
    lastOdometer: odos.length ? Math.max(...odos) : null,
  };
}

// ---------------------------------------------------------------- charts (inline SVG)
function niceTicks(maxV) {
  const raw = maxV / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  return [step, step * 2, step * 3, step * 4];
}

function svgLine(series, { labelFn }) {
  if (series.length < 2) {
    return `<div class="logempty">Not enough data yet — log a few fuelups to see this chart.</div>`;
  }
  const W = 700, H = 340, padL = 8, padR = 10, padT = 26, padB = 16;
  const vals = series.map((p) => p.v);
  const maxV = Math.max(...vals) * 1.06;
  const ticks = niceTicks(maxV);
  const top = ticks[3];
  const x = (i) => padL + (i / (series.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / top) * (H - padT - padB);
  const grid = ticks.map((t) =>
    `<line x1="${padL}" y1="${y(t)}" x2="${W - padR}" y2="${y(t)}" stroke="#d8d6c8" stroke-width="1"/>
     <text x="${W - padR}" y="${y(t) - 6}" text-anchor="end" font-size="17" fill="#77776d">${labelFn(t)}</text>`).join('');
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const dots = series.length <= 90
    ? series.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="6" fill="#3f9c91"/>`).join('')
    : '';
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    <line x1="${padL}" y1="${padT - 10}" x2="${padL}" y2="${H - padB}" stroke="#b9b7aa" stroke-width="2"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#d8d6c8" stroke-width="1"/>
    ${grid}
    <polyline points="${pts}" fill="none" stroke="#3f9c91" stroke-width="3.4" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

function svgBars(values) {
  const W = 560, H = 300, gap = 18;
  if (!values.length) return '';
  const bw = Math.min(46, (W - gap * (values.length + 1)) / values.length);
  const maxV = Math.max(...values) * 1.12;
  const startX = W - values.length * (bw + gap);
  const bars = values.map((v, i) => {
    const h = Math.max(6, (v / maxV) * (H - 20));
    return `<rect x="${(startX + i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="#efa33d"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${bars}</svg>`;
}

function svgPie(cityPct) {
  const hw = 100 - cityPct;
  const r = 74, cx = 90, cy = 90;
  // City slice starts at 12 o'clock going clockwise; highway is the rest.
  const angle = (cityPct / 100) * Math.PI * 2;
  const x2 = cx + r * Math.sin(angle), y2 = cy - r * Math.cos(angle);
  const largeCity = cityPct > 50 ? 1 : 0;
  const cityPath = cityPct >= 100 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#46b1a5"/>`
    : cityPct <= 0 ? ''
    : `<path d="M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeCity} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="#46b1a5"/>`;
  const hwPath = hw >= 100 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f0a63a"/>`
    : hw <= 0 ? ''
    : `<path d="M${cx},${cy} L${x2.toFixed(1)},${y2.toFixed(1)} A${r},${r} 0 ${largeCity ? 0 : 1} 1 ${cx},${cy - r} Z" fill="#f0a63a"/>`;
  const midAngle = (frac) => {
    const a = frac * Math.PI * 2;
    return [cx + r * 0.55 * Math.sin(a), cy - r * 0.55 * Math.cos(a)];
  };
  const [cxl, cyl] = midAngle(cityPct / 200);
  const [hxl, hyl] = midAngle((cityPct + hw / 2) / 100);
  const lbl = (x, y, t) => t >= 8
    ? `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle" dominant-baseline="middle" font-size="22" font-weight="600" fill="#fff">${t}</text>` : '';
  return `<svg viewBox="0 0 180 180" style="max-width:230px;margin:0 auto" role="img">
    ${hwPath}${cityPath}${lbl(cxl, cyl, cityPct)}${lbl(hxl, hyl, hw)}
  </svg>`;
}

// ---------------------------------------------------------------- icons
const ICON = {
  fuel: '<svg viewBox="0 0 24 24"><path d="M5 4h8a1 1 0 0 1 1 1v15H4V5a1 1 0 0 1 1-1zm2 3h4v4H7V7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 10h1.8a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 0 2.4 0V9l-2.2-2.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M3 20h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M13.8 6a4.1 4.1 0 0 1 5.3-4.7L16.6 3.8l.6 2.7 2.7.6 2.5-2.5A4.1 4.1 0 0 1 17.7 10L8.3 20.6a1.9 1.9 0 0 1-2.8-2.7L13.8 6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" transform="translate(-1 1) scale(.92)"/></svg>',
  note: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15.5 8.2l-6 6-.5 2.3 2.3-.5 6-6-1.8-1.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M12 4a6 6 0 0 1 6 6v3.5l1.5 2.5H4.5L6 13.5V10a6 6 0 0 1 6-6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M4 13l1.6-4.5A2 2 0 0 1 7.5 7h9a2 2 0 0 1 1.9 1.5L20 13v5h-2.2v-1.6H6.2V18H4v-5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="7.6" cy="14.4" r="1.1" fill="currentColor"/><circle cx="16.4" cy="14.4" r="1.1" fill="currentColor"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="14" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17.6" cy="10.6" r=".9" fill="currentColor"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><path d="M8.5 12.5l6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.3 8.3a5.3 5.3 0 0 1-7.5-7.5L11.8 3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="scale(.9) translate(1.3 1.3)"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-8 0l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eyeoff: '<svg viewBox="0 0 24 24"><path d="M4 12s3-5.5 8-5.5S20 12 20 12s-3 5.5-8 5.5S4 12 4 12z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 19L19 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 15V5m0 0L8 9m4-4l4 4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M6 4v6m0 4v6m6-16v2m0 4v10m6-16v10m0 4v2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="6" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="18" cy="16" r="2" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>',
};

// ---------------------------------------------------------------- photos
async function resizeImage(file, maxDim = 1600, quality = 0.85) {
  if (file.type === 'application/pdf' || !file.type.startsWith('image/')) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Attachment block used inside forms. For unsaved entities photos are queued
// in `pending` and uploaded by the form's save handler once the id exists.
function photoBlock({ label, kind, entityType, entityId, existing = [], pending, accept = 'image/*' }) {
  const wrap = el(`<div class="formrow">
    <span class="flabel">${esc(label)}</span>
    <button type="button" class="attachbtn"><span class="abox">${kind === 'photo' ? ICON.camera : ICON.clip}</span><span>${kind === 'photo' ? '' : `Add ${esc(label.replace(/s$/, ''))}`}</span></button>
    <div class="thumbs"></div>
    <input type="file" accept="${accept}" multiple hidden>
  </div>`);
  const thumbs = $('.thumbs', wrap);
  const input = $('input[type=file]', wrap);

  function thumbEl(src, name, onDel) {
    const isImg = /^data:image|\.(jpe?g|png|webp|gif|heic)$/i.test(src) || src.startsWith('/uploads/') && !/\.pdf$/i.test(src);
    const t = el(`<div class="thumb">${isImg ? `<img src="${esc(src)}" alt="">` : `<span class="doc">${esc(name || 'file')}</span>`}<button type="button" class="del">✕</button></div>`);
    $('.del', t).onclick = onDel;
    return t;
  }

  function renderThumbs() {
    thumbs.innerHTML = '';
    for (const p of existing) {
      thumbs.append(thumbEl(`/uploads/${p.filename}`, p.original_name, async () => {
        if (!confirm('Remove this attachment?')) return;
        await DEL(`/api/photos/${p.id}`);
        existing.splice(existing.indexOf(p), 1);
        renderThumbs();
      }));
    }
    pending.forEach((q, i) => {
      if (q.kind !== kind) return;
      thumbs.append(thumbEl(q.data, q.name, () => { pending.splice(i, 1); renderThumbs(); }));
    });
  }

  $('.attachbtn', wrap).onclick = () => input.click();
  input.onchange = async () => {
    for (const f of input.files) {
      const data = await resizeImage(f);
      if (entityId) {
        const saved = await POST('/api/photos', { entity_type: entityType, entity_id: entityId, kind, name: f.name, data });
        existing.push(saved);
      } else {
        pending.push({ kind, name: f.name, data });
      }
    }
    input.value = '';
    renderThumbs();
  };
  renderThumbs();
  return wrap;
}

async function uploadPending(pending, entityType, entityId) {
  for (const q of pending) {
    await POST('/api/photos', { entity_type: entityType, entity_id: entityId, kind: q.kind, name: q.name, data: q.data });
  }
}

// ---------------------------------------------------------------- sheets (pickers)
function openSheet({ title, options, selected = [], multi = false, allowCustom = true, onDone }) {
  const scrim = el(`<div class="sheet-scrim">
    <div class="sheet">
      <h3><span>${esc(title)}</span><button type="button" class="sheetdone">Done</button></h3>
      <div class="sheetbody">
        <div class="opts"></div>
        ${allowCustom ? `<div class="sheetadd"><input type="text" placeholder="Add custom…"><button type="button">Add</button></div>` : ''}
      </div>
    </div>
  </div>`);
  const sel = new Set(selected);
  const optsDiv = $('.opts', scrim);
  let opts = [...options];
  for (const s of selected) if (!opts.includes(s) && s) opts.push(s);

  function renderOpts() {
    optsDiv.innerHTML = '';
    for (const o of opts) {
      const b = el(`<button type="button" class="sheetopt ${sel.has(o) ? 'selected' : ''}"><span>${esc(o)}</span>${sel.has(o) ? '<span class="check">✓</span>' : ''}</button>`);
      b.onclick = () => {
        if (multi) {
          sel.has(o) ? sel.delete(o) : sel.add(o);
          renderOpts();
        } else {
          close();
          onDone([o]);
        }
      };
      optsDiv.append(b);
    }
  }
  function close() { scrim.remove(); }
  $('.sheetdone', scrim).onclick = () => { close(); onDone([...sel]); };
  scrim.onclick = (e) => { if (e.target === scrim) { close(); if (multi) onDone([...sel]); } };
  if (allowCustom) {
    const inp = $('.sheetadd input', scrim);
    $('.sheetadd button', scrim).onclick = () => {
      const v = inp.value.trim();
      if (!v) return;
      if (!opts.includes(v)) opts.push(v);
      sel.add(v);
      inp.value = '';
      if (!multi) { close(); onDone([v]); return; }
      renderOpts();
    };
  }
  renderOpts();
  document.body.append(scrim);
}

const DEFAULT_FUEL_TYPES = ['Regular [Octane: 87]', 'Midgrade [Octane: 89]', 'Premium [Octane: 91]', 'Premium [Octane: 93]', 'Diesel', 'E85 Flex Fuel'];
const DEFAULT_PAYMENTS = ['Credit', 'Debit', 'Cash', 'Mobile Pay', 'Check', 'Fleet Card'];
const DEFAULT_SERVICES = ['Oil Change', 'Tire Rotation', 'New Tires', 'Tire Repair', 'Brake Pads', 'Brake Service', 'Engine Air Filter', 'Cabin Air Filter', 'Battery', 'Wiper Blades', 'Alignment', 'Coolant Flush', 'Transmission Service', 'Spark Plugs', 'Inspection', 'Registration', 'Car Wash', 'Detailing', 'Repair'];
const DEFAULT_TRANSMISSIONS = ['Automatic', 'Automatic CVT', 'Manual', 'Dual-Clutch', 'Single-Speed (EV)'];

function customList(key, defaults) {
  const saved = store.get(`custom:${key}`, []);
  return [...defaults, ...saved.filter((s) => !defaults.includes(s))];
}
function rememberCustom(key, defaults, values) {
  const saved = store.get(`custom:${key}`, []);
  let changed = false;
  for (const v of values) {
    if (v && !defaults.includes(v) && !saved.includes(v)) { saved.push(v); changed = true; }
  }
  if (changed) store.set(`custom:${key}`, saved);
}

// ---------------------------------------------------------------- modal shell
function openModal({ title, body, onSave, footer }) {
  const modal = el(`<div class="modal">
    <div class="modalbar">
      <button type="button" class="mbtn mclose" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <h2>${esc(title)}</h2>
      <button type="button" class="mbtn save">${onSave ? 'Save' : ''}</button>
    </div>
    <div class="modalbody"><div class="container"></div></div>
  </div>`);
  const container = $('.container', modal);
  container.append(body);
  if (footer) container.append(footer);
  const close = () => modal.remove();
  $('.mclose', modal).onclick = close;
  if (onSave) {
    $('.save', modal).onclick = async () => {
      const btn = $('.save', modal);
      btn.disabled = true;
      try {
        if (await onSave() !== false) close();
      } catch (e) {
        toast('Error: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    };
  }
  document.body.append(modal);
  return { close, modal };
}

// form field helpers -------------------------------------------------------
const fText = (label, id, value = '', ph = '', type = 'text', step) =>
  `<div class="formrow"><label class="flabel" for="${id}">${label}</label>
   <input type="${type}" id="${id}" value="${esc(value ?? '')}" placeholder="${esc(ph)}" ${step ? `step="${step}"` : ''} ${type === 'number' ? 'inputmode="decimal"' : ''}></div>`;

const fTap = (label, id, value, ph = '') =>
  `<div class="formrow tappable" id="${id}"><span class="flabel">${label}</span>
   <div class="fvalue ${value ? '' : 'empty'}">${esc(value || ph)}</div></div>`;

// ---------------------------------------------------------------- fuelup form
function fuelupForm(existing) {
  const isNew = !existing;
  const f = existing || {};
  const u = units();
  const stats = computeFuel();
  const pending = [];
  let photos = [], receipts = [];
  let fuelType = f.fuel_type || store.get('lastFuelType', DEFAULT_FUEL_TYPES[0]);
  let payment = f.payment || store.get('lastPayment', 'Credit');

  const body = el(`<div>
    ${fTap('Vehicle', 'vehRow', S.vehicle.name)}
    <div class="formgrid">
      <div class="formrow"><label class="flabel" for="fOdo">Odometer</label>
        <input type="number" id="fOdo" inputmode="decimal" step="any" placeholder="0,000.00" value="${f.odometer ?? ''}"></div>
      <div class="formrow"><span class="flabel">Last Odometer</span>
        <div class="formstatic">${stats.lastOdometer != null ? num(stats.lastOdometer, 1) : '--'}</div></div>
    </div>
    <div class="formgrid thirds">
      <div class="formrow"><label class="flabel" for="fCpg">Cost / ${u.fuel === 'gal' ? 'Gal.' : 'L'}</label>
        <input type="number" id="fCpg" inputmode="decimal" step="any" placeholder="0.000" value="${f.cost_per_gal ?? ''}"></div>
      <div class="formrow"><label class="flabel" for="fGal">${u.fuelLong}</label>
        <input type="number" id="fGal" inputmode="decimal" step="any" placeholder="0.000" value="${f.gallons ?? ''}"></div>
      <div class="formrow"><label class="flabel" for="fTot">Total Cost</label>
        <input type="number" id="fTot" inputmode="decimal" step="any" placeholder="0.00" value="${f.total_cost ?? ''}"></div>
    </div>
    <div class="formgrid">
      <div class="formrow"><span class="flabel">Partial Fuel-up?</span>
        <label class="checkrow"><input type="checkbox" id="fPartial" ${f.partial ? 'checked' : ''}><span>Yes</span></label></div>
      <div class="formrow"><span class="flabel">Missed Fuel-up?</span>
        <label class="checkrow"><input type="checkbox" id="fMissed" ${f.missed ? 'checked' : ''}><span>Reset</span></label></div>
    </div>
    ${S.vehicle.track_city_hwy ? `<div class="formrow slider-row">
      <span class="flabel">City Driving %</span>
      <div class="slider-val" id="cityVal">${f.city_pct ?? 50}%</div>
      <input type="range" id="fCity" min="0" max="100" step="5" value="${f.city_pct ?? 50}">
    </div>` : ''}
    ${fTap('Fuel Type (Octane)', 'fuelTypeRow', fuelType)}
    <div class="formrow"><label class="flabel" for="fDate">Date</label>
      <input type="datetime-local" id="fDate" value="${toLocalInput(f.date)}"></div>
    ${fText('Location', 'fLoc', f.location, '--')}
    ${fTap('Payment Method', 'payRow', payment)}
    <div id="receiptSlot"></div>
    <div id="photoSlot"></div>
    <div class="formrow"><label class="flabel" for="fNotes">Notes</label>
      <textarea id="fNotes" placeholder="">${esc(f.notes || '')}</textarea></div>
  </div>`);

  // auto-complete third value among cost/gal, gallons, total
  const cpg = $('#fCpg', body), gal = $('#fGal', body), tot = $('#fTot', body);
  const recompute = (src) => {
    const c = parseFloat(cpg.value), g = parseFloat(gal.value), t = parseFloat(tot.value);
    if (src !== 'tot' && !isNaN(c) && !isNaN(g)) tot.value = (c * g).toFixed(2);
    else if (src === 'tot' && !isNaN(t) && !isNaN(g) && g > 0) cpg.value = (t / g).toFixed(3);
    else if (src === 'tot' && !isNaN(t) && !isNaN(c) && c > 0) gal.value = (t / c).toFixed(3);
  };
  cpg.oninput = () => recompute('cpg');
  gal.oninput = () => recompute('gal');
  tot.oninput = () => recompute('tot');

  const cityRange = $('#fCity', body);
  if (cityRange) cityRange.oninput = () => { $('#cityVal', body).textContent = cityRange.value + '%'; };

  $('#fuelTypeRow', body).onclick = () => openSheet({
    title: 'Fuel Type', options: customList('fuelTypes', DEFAULT_FUEL_TYPES), selected: [fuelType],
    onDone: ([v]) => { if (v) { fuelType = v; $('#fuelTypeRow .fvalue', body).textContent = v; } },
  });
  $('#payRow', body).onclick = () => openSheet({
    title: 'Payment Method', options: customList('payments', DEFAULT_PAYMENTS), selected: [payment],
    onDone: ([v]) => { if (v) { payment = v; $('#payRow .fvalue', body).textContent = v; } },
  });
  $('#vehRow', body).onclick = () => openSheet({
    title: 'Vehicle', options: S.vehicles.filter((v) => !v.retired).map((v) => v.name),
    selected: [S.vehicle.name], allowCustom: false,
    onDone: async ([name]) => {
      const v = S.vehicles.find((x) => x.name === name);
      if (v && v.id !== S.vehicle.id) { await setActiveVehicle(v.id); $('#vehRow .fvalue', body).textContent = v.name; }
    },
  });

  (async () => {
    if (!isNew) {
      const all = await GET(`/api/photos?entity_type=fuelup&entity_id=${f.id}`);
      receipts = all.filter((p) => p.kind === 'receipt');
      photos = all.filter((p) => p.kind === 'photo');
    }
    $('#receiptSlot', body).replaceWith(photoBlock({ label: 'Receipts', kind: 'receipt', entityType: 'fuelup', entityId: f.id, existing: receipts, pending, accept: 'image/*,application/pdf' }));
    $('#photoSlot', body).replaceWith(photoBlock({ label: 'Photos', kind: 'photo', entityType: 'fuelup', entityId: f.id, existing: photos, pending }));
  })();

  let footer = null;
  if (!isNew) {
    footer = el(`<div class="formfooter"><span></span><button type="button" class="danger">${ICON.trash} Delete</button></div>`);
    $('.danger', footer).onclick = async () => {
      if (!confirm('Delete this fuelup?')) return;
      await DEL(`/api/fuelups/${f.id}`);
      $('.modal')?.remove();
      toast('Fuelup deleted');
      refresh();
    };
  }

  openModal({
    title: isNew ? 'New Fuelup' : 'Edit Fuelup',
    body, footer,
    onSave: async () => {
      const numOr = (elm) => elm.value === '' ? null : parseFloat(elm.value);
      const payload = {
        vehicle_id: S.vehicle.id,
        date: new Date($('#fDate', body).value).toISOString(),
        odometer: numOr($('#fOdo', body)),
        cost_per_gal: numOr(cpg), gallons: numOr(gal), total_cost: numOr(tot),
        partial: $('#fPartial', body).checked ? 1 : 0,
        missed: $('#fMissed', body).checked ? 1 : 0,
        city_pct: cityRange ? parseInt(cityRange.value, 10) : null,
        fuel_type: fuelType, location: $('#fLoc', body).value.trim(),
        payment, notes: $('#fNotes', body).value.trim(),
      };
      rememberCustom('fuelTypes', DEFAULT_FUEL_TYPES, [fuelType]);
      rememberCustom('payments', DEFAULT_PAYMENTS, [payment]);
      store.set('lastFuelType', fuelType);
      store.set('lastPayment', payment);
      const saved = isNew ? await POST('/api/fuelups', payload) : await PUT(`/api/fuelups/${f.id}`, payload);
      await uploadPending(pending, 'fuelup', saved.id);
      toast(isNew ? 'Fuelup saved' : 'Fuelup updated');
      refresh();
    },
  });
}

// ---------------------------------------------------------------- service form
function serviceForm(existing) {
  const isNew = !existing;
  const s = existing || {};
  const pending = [];
  let photos = [], receipts = [];
  let services = s.services ? JSON.parse(s.services) : [];
  let tags = s.tags ? JSON.parse(s.tags) : [];
  let payment = s.payment || '';

  const body = el(`<div>
    ${fTap('Vehicle', 'vehRow', S.vehicle.name)}
    <div class="formgrid">
      <div class="formrow"><label class="flabel" for="sOdo">Odometer</label>
        <input type="number" id="sOdo" inputmode="decimal" step="any" placeholder="00000" value="${s.odometer ?? ''}"></div>
      <div class="formrow"><label class="flabel" for="sCost">Total Cost</label>
        <input type="number" id="sCost" inputmode="decimal" step="any" placeholder="0.00" value="${s.total_cost ?? ''}"></div>
    </div>
    <div class="formrow"><label class="flabel" for="sDate">Date</label>
      <input type="datetime-local" id="sDate" value="${toLocalInput(s.date)}"></div>
    ${fTap('Services', 'svcRow', services.join(', '))}
    <div id="receiptSlot"></div>
    <div id="photoSlot"></div>
    ${fText('Location', 'sLoc', s.location, '')}
    ${fTap('Tags', 'tagRow', tags.join(', '))}
    ${fTap('Payment Type', 'payRow', payment)}
    <div class="formrow"><label class="flabel" for="sNotes">Notes</label>
      <textarea id="sNotes" placeholder="">${esc(s.notes || '')}</textarea></div>
  </div>`);

  $('#svcRow', body).onclick = () => openSheet({
    title: 'Services', options: customList('services', DEFAULT_SERVICES), selected: services, multi: true,
    onDone: (sel) => {
      services = sel;
      const fv = $('#svcRow .fvalue', body);
      fv.textContent = sel.join(', ');
      fv.classList.toggle('empty', !sel.length);
    },
  });
  $('#tagRow', body).onclick = () => openSheet({
    title: 'Tags', options: customList('tags', []), selected: tags, multi: true,
    onDone: (sel) => {
      tags = sel;
      const fv = $('#tagRow .fvalue', body);
      fv.textContent = sel.join(', ');
      fv.classList.toggle('empty', !sel.length);
    },
  });
  $('#payRow', body).onclick = () => openSheet({
    title: 'Payment Type', options: customList('payments', DEFAULT_PAYMENTS), selected: [payment],
    onDone: ([v]) => { if (v) { payment = v; $('#payRow .fvalue', body).textContent = v; } },
  });
  $('#vehRow', body).onclick = () => openSheet({
    title: 'Vehicle', options: S.vehicles.filter((v) => !v.retired).map((v) => v.name),
    selected: [S.vehicle.name], allowCustom: false,
    onDone: async ([name]) => {
      const v = S.vehicles.find((x) => x.name === name);
      if (v && v.id !== S.vehicle.id) { await setActiveVehicle(v.id); $('#vehRow .fvalue', body).textContent = v.name; }
    },
  });

  (async () => {
    if (!isNew) {
      const all = await GET(`/api/photos?entity_type=service&entity_id=${s.id}`);
      receipts = all.filter((p) => p.kind === 'receipt');
      photos = all.filter((p) => p.kind === 'photo');
    }
    $('#receiptSlot', body).replaceWith(photoBlock({ label: 'Service Receipts', kind: 'receipt', entityType: 'service', entityId: s.id, existing: receipts, pending, accept: 'image/*,application/pdf' }));
    $('#photoSlot', body).replaceWith(photoBlock({ label: 'Photos', kind: 'photo', entityType: 'service', entityId: s.id, existing: photos, pending }));
  })();

  let footer = null;
  if (!isNew) {
    footer = el(`<div class="formfooter"><span></span><button type="button" class="danger">${ICON.trash} Delete</button></div>`);
    $('.danger', footer).onclick = async () => {
      if (!confirm('Delete this service entry?')) return;
      await DEL(`/api/services/${s.id}`);
      $('.modal')?.remove();
      toast('Service deleted');
      refresh();
    };
  }

  openModal({
    title: isNew ? 'New Service' : 'Edit Service',
    body, footer,
    onSave: async () => {
      const numOr = (elm) => elm.value === '' ? null : parseFloat(elm.value);
      rememberCustom('services', DEFAULT_SERVICES, services);
      rememberCustom('tags', [], tags);
      rememberCustom('payments', DEFAULT_PAYMENTS, [payment]);
      const payload = {
        vehicle_id: S.vehicle.id,
        date: new Date($('#sDate', body).value).toISOString(),
        odometer: numOr($('#sOdo', body)), total_cost: numOr($('#sCost', body)),
        services, tags, payment,
        location: $('#sLoc', body).value.trim(),
        notes: $('#sNotes', body).value.trim(),
      };
      const saved = isNew ? await POST('/api/services', payload) : await PUT(`/api/services/${s.id}`, payload);
      await uploadPending(pending, 'service', saved.id);
      toast(isNew ? 'Service saved' : 'Service updated');
      refresh();
    },
  });
}

// ---------------------------------------------------------------- note form
function noteForm(existing) {
  const isNew = !existing;
  const n = existing || {};
  const pending = [];
  let photos = [];

  const body = el(`<div>
    ${fTap('Vehicle', 'vehRow', S.vehicle.name)}
    <div class="formrow"><label class="flabel" for="nDate">Date</label>
      <input type="datetime-local" id="nDate" value="${toLocalInput(n.date)}"></div>
    ${fText('Title', 'nTitle', n.title, '')}
    <div class="formrow"><label class="flabel" for="nText">Note</label>
      <textarea id="nText" placeholder="">${esc(n.text || '')}</textarea></div>
    <div id="photoSlot"></div>
  </div>`);

  $('#vehRow', body).onclick = () => {};

  (async () => {
    if (!isNew) photos = await GET(`/api/photos?entity_type=note&entity_id=${n.id}`);
    $('#photoSlot', body).replaceWith(photoBlock({ label: 'Photos', kind: 'photo', entityType: 'note', entityId: n.id, existing: photos, pending }));
  })();

  let footer = null;
  if (!isNew) {
    footer = el(`<div class="formfooter"><span></span><button type="button" class="danger">${ICON.trash} Delete</button></div>`);
    $('.danger', footer).onclick = async () => {
      if (!confirm('Delete this note?')) return;
      await DEL(`/api/notes/${n.id}`);
      $('.modal')?.remove();
      toast('Note deleted');
      refresh();
    };
  }

  openModal({
    title: isNew ? 'New Note' : 'Edit Note',
    body, footer,
    onSave: async () => {
      const payload = {
        vehicle_id: S.vehicle.id,
        date: new Date($('#nDate', body).value).toISOString(),
        title: $('#nTitle', body).value.trim(),
        text: $('#nText', body).value.trim(),
      };
      if (!payload.title && !payload.text) { toast('Write something first'); return false; }
      const saved = isNew ? await POST('/api/notes', payload) : await PUT(`/api/notes/${n.id}`, payload);
      await uploadPending(pending, 'note', saved.id);
      toast(isNew ? 'Note saved' : 'Note updated');
      refresh();
    },
  });
}

// ---------------------------------------------------------------- reminder form
function reminderForm(existing) {
  const isNew = !existing;
  const r = existing || {};
  const u = units();
  let title = r.title || '';

  const body = el(`<div>
    ${fTap('Vehicle', 'vehRow', S.vehicle.name)}
    ${fTap('Remind me about', 'titleRow', title, 'Choose or type a service…')}
    <div class="formrow"><label class="flabel" for="rDate">Due Date (optional)</label>
      <input type="date" id="rDate" value="${r.due_date ? String(r.due_date).slice(0, 10) : ''}"></div>
    <div class="formrow"><label class="flabel" for="rOdo">Due Odometer (${u.distLong.toLowerCase()}, optional)</label>
      <input type="number" id="rOdo" inputmode="decimal" step="any" placeholder="e.g. 48000" value="${r.due_odometer ?? ''}"></div>
    <div class="formgrid">
      <div class="formrow"><label class="flabel" for="rRepM">Repeat Every (months)</label>
        <input type="number" id="rRepM" inputmode="numeric" placeholder="--" value="${r.repeat_months ?? ''}"></div>
      <div class="formrow"><label class="flabel" for="rRepD">Repeat Every (${u.distLong.toLowerCase()})</label>
        <input type="number" id="rRepD" inputmode="decimal" placeholder="--" value="${r.repeat_distance ?? ''}"></div>
    </div>
    <div class="formrow"><span class="flabel">Completed?</span>
      <label class="checkrow"><input type="checkbox" id="rDone" ${r.done ? 'checked' : ''}><span>Done</span></label></div>
    <div class="formrow"><label class="flabel" for="rNotes">Notes</label>
      <textarea id="rNotes" placeholder="">${esc(r.notes || '')}</textarea></div>
  </div>`);

  $('#titleRow', body).onclick = () => openSheet({
    title: 'Remind me about', options: customList('services', DEFAULT_SERVICES), selected: title ? [title] : [],
    onDone: ([v]) => {
      if (v) {
        title = v;
        const fv = $('#titleRow .fvalue', body);
        fv.textContent = v;
        fv.classList.remove('empty');
      }
    },
  });

  let footer = null;
  if (!isNew) {
    footer = el(`<div class="formfooter"><span></span><button type="button" class="danger">${ICON.trash} Delete</button></div>`);
    $('.danger', footer).onclick = async () => {
      if (!confirm('Delete this reminder?')) return;
      await DEL(`/api/reminders/${r.id}`);
      $('.modal')?.remove();
      toast('Reminder deleted');
      refresh();
    };
  }

  openModal({
    title: isNew ? 'New Reminder' : 'Edit Reminder',
    body, footer,
    onSave: async () => {
      if (!title) { toast('Choose what to be reminded about'); return false; }
      const numOr = (elm) => elm.value === '' ? null : parseFloat(elm.value);
      const payload = {
        vehicle_id: S.vehicle.id, title,
        due_date: $('#rDate', body).value || null,
        due_odometer: numOr($('#rOdo', body)),
        repeat_months: numOr($('#rRepM', body)),
        repeat_distance: numOr($('#rRepD', body)),
        done: $('#rDone', body).checked ? 1 : 0,
        notes: $('#rNotes', body).value.trim(),
      };
      isNew ? await POST('/api/reminders', payload) : await PUT(`/api/reminders/${r.id}`, payload);
      toast(isNew ? 'Reminder saved' : 'Reminder updated');
      refresh();
    },
  });
}

// ---------------------------------------------------------------- vehicle form
function vehicleForm(existing) {
  const isNew = !existing;
  const v = existing || {};
  const pending = [];
  let photos = [], insuranceCards = [], receipts = [];
  let transmission = v.transmission || '';
  let country = v.country || 'United States';
  let distanceUnit = v.distance_unit || 'mi';
  let fuelUnit = v.fuel_unit || 'gal';
  let fuelTracking = v.fuel_tracking || 'odometer';
  let trackCity = v.track_city_hwy !== 0;

  const body = el(`<div>
    ${fText('Vehicle Name', 'vName', v.name, 'e.g. Red Civic')}
    <div class="formgrid">
      <div class="formrow"><label class="flabel" for="vYear">Year</label>
        <input type="number" id="vYear" inputmode="numeric" placeholder="2024" value="${v.year ?? ''}"></div>
      <div class="formrow"><label class="flabel" for="vMake">Make</label>
        <input type="text" id="vMake" placeholder="Honda" value="${esc(v.make || '')}"></div>
    </div>
    ${fText('Model', 'vModel', v.model, 'Civic Touring')}
    ${fText('VIN #', 'vVin', v.vin, '')}
    <div id="photoSlot"></div>
    ${fText('Engine', 'vEngine', v.engine, '1.5L L4 GAS')}
    ${fTap('Transmission', 'transRow', transmission, 'Select…')}
    <div class="formgrid">
      ${fText('License Plate', 'vPlate', v.license_plate, '')}
      ${fText('Insurance Policy', 'vPolicy', v.insurance_policy, '')}
    </div>
    <div id="insSlot"></div>
    ${fText('Tire Size', 'vTireSize', v.tire_size, '')}
    ${fText('Tire Pressure', 'vTirePres', v.tire_pressure, '')}
    ${fText('Country', 'vCountry', country, '')}
    <div class="formgrid">
      ${fTap('Distance Unit', 'distRow', distanceUnit === 'mi' ? 'Miles' : 'Kilometers')}
      ${fTap('Fuel Unit', 'fuelRow', fuelUnit === 'gal' ? 'Gallons' : 'Liters')}
    </div>
    ${fTap('Fuel Tracking', 'trackRow', fuelTracking === 'odometer' ? 'Odometer' : 'Trip Distance')}
    ${fTap('Track City / Highway', 'cityRow', trackCity ? 'Yes' : 'No')}
    <div id="receiptSlot"></div>
    <div class="formrow"><label class="flabel" for="vNotes">Vehicle Note (Private)</label>
      <textarea id="vNotes">${esc(v.notes || '')}</textarea></div>
  </div>`);

  const bindPick = (rowId, title, options, current, cb, allowCustom = true) => {
    $(rowId, body).onclick = () => openSheet({
      title, options, selected: [current()], allowCustom,
      onDone: ([val]) => { if (val) cb(val); },
    });
  };
  bindPick('#transRow', 'Transmission', DEFAULT_TRANSMISSIONS, () => transmission, (val) => {
    transmission = val;
    const fv = $('#transRow .fvalue', body);
    fv.textContent = val;
    fv.classList.remove('empty');
  });
  bindPick('#distRow', 'Distance Unit', ['Miles', 'Kilometers'], () => distanceUnit === 'mi' ? 'Miles' : 'Kilometers', (val) => {
    distanceUnit = val === 'Miles' ? 'mi' : 'km';
    $('#distRow .fvalue', body).textContent = val;
  }, false);
  bindPick('#fuelRow', 'Fuel Unit', ['Gallons', 'Liters'], () => fuelUnit === 'gal' ? 'Gallons' : 'Liters', (val) => {
    fuelUnit = val === 'Gallons' ? 'gal' : 'L';
    $('#fuelRow .fvalue', body).textContent = val;
  }, false);
  bindPick('#trackRow', 'Fuel Tracking', ['Odometer', 'Trip Distance'], () => fuelTracking === 'odometer' ? 'Odometer' : 'Trip Distance', (val) => {
    fuelTracking = val === 'Odometer' ? 'odometer' : 'trip';
    $('#trackRow .fvalue', body).textContent = val;
  }, false);
  bindPick('#cityRow', 'Track City / Highway', ['Yes', 'No'], () => trackCity ? 'Yes' : 'No', (val) => {
    trackCity = val === 'Yes';
    $('#cityRow .fvalue', body).textContent = val;
  }, false);

  (async () => {
    if (!isNew) {
      const all = await GET(`/api/photos?entity_type=vehicle&entity_id=${v.id}`);
      photos = all.filter((p) => p.kind === 'photo');
      insuranceCards = all.filter((p) => p.kind === 'insurance_card');
      receipts = all.filter((p) => p.kind === 'receipt');
    }
    $('#photoSlot', body).replaceWith(photoBlock({ label: 'Photos', kind: 'photo', entityType: 'vehicle', entityId: v.id, existing: photos, pending }));
    $('#insSlot', body).replaceWith(photoBlock({ label: 'Insurance Card', kind: 'insurance_card', entityType: 'vehicle', entityId: v.id, existing: insuranceCards, pending, accept: 'image/*,application/pdf' }));
    $('#receiptSlot', body).replaceWith(photoBlock({ label: 'Receipts', kind: 'receipt', entityType: 'vehicle', entityId: v.id, existing: receipts, pending, accept: 'image/*,application/pdf' }));
  })();

  let footer = null;
  if (!isNew) {
    footer = el(`<div class="formfooter">
      <button type="button" class="retire">${ICON.eyeoff} ${v.retired ? 'Unretire' : 'Retire'}</button>
      <button type="button" class="danger">${ICON.trash} Delete</button>
    </div>`);
    $('.retire', footer).onclick = async () => {
      await PUT(`/api/vehicles/${v.id}`, { retired: v.retired ? 0 : 1 });
      $('.modal')?.remove();
      toast(v.retired ? 'Vehicle restored' : 'Vehicle retired');
      await loadVehicles();
      refresh();
    };
    $('.danger', footer).onclick = async () => {
      if (!confirm(`Delete "${v.name}" and ALL of its logs? This cannot be undone.`)) return;
      if (!confirm('Are you absolutely sure? Consider exporting your data first (menu → Export).')) return;
      await DEL(`/api/vehicles/${v.id}`);
      $('.modal')?.remove();
      toast('Vehicle deleted');
      store.set('activeVehicleId', null);
      await loadVehicles();
      refresh();
    };
  }

  openModal({
    title: isNew ? 'New Vehicle' : 'Edit Vehicle',
    body, footer,
    onSave: async () => {
      const name = $('#vName', body).value.trim();
      if (!name) { toast('Give the vehicle a name'); return false; }
      const payload = {
        name,
        year: $('#vYear', body).value ? parseInt($('#vYear', body).value, 10) : null,
        make: $('#vMake', body).value.trim(), model: $('#vModel', body).value.trim(),
        vin: $('#vVin', body).value.trim(), engine: $('#vEngine', body).value.trim(),
        transmission, license_plate: $('#vPlate', body).value.trim(),
        insurance_policy: $('#vPolicy', body).value.trim(),
        tire_size: $('#vTireSize', body).value.trim(), tire_pressure: $('#vTirePres', body).value.trim(),
        country: $('#vCountry', body).value.trim(),
        distance_unit: distanceUnit, fuel_unit: fuelUnit, fuel_tracking: fuelTracking,
        track_city_hwy: trackCity ? 1 : 0,
        notes: $('#vNotes', body).value.trim(),
      };
      const saved = isNew ? await POST('/api/vehicles', payload) : await PUT(`/api/vehicles/${v.id}`, payload);
      await uploadPending(pending, 'vehicle', saved.id);
      toast(isNew ? 'Vehicle added' : 'Vehicle updated');
      await loadVehicles();
      if (isNew) await setActiveVehicle(saved.id);
      else refresh();
    },
  });
}

// ---------------------------------------------------------------- views
function reminderIsDue(r, lastOdo) {
  if (r.done) return false;
  const dateDue = r.due_date && new Date(r.due_date) <= new Date();
  const odoDue = r.due_odometer != null && lastOdo != null && lastOdo >= r.due_odometer;
  return !!(dateDue || odoDue);
}

function renderVehicleInfo(view) {
  const stats = computeFuel();
  const u = units();
  const heroPhoto = S.vehiclePhotos.find((p) => p.kind === 'photo');

  const dueReminders = S.reminders.filter((r) => reminderIsDue(r, stats.lastOdometer));

  view.innerHTML = `
    <div class="hero">
      ${heroPhoto
        ? `<img src="/uploads/${esc(heroPhoto.filename)}" alt="${esc(S.vehicle.name)}">`
        : `<div class="noimg">${ICON.car.replace('viewBox', 'width="72" height="72" viewBox')}</div>`}
      <div class="heroname">${esc(S.vehicle.name)}</div>
      <button class="herocam" id="heroCamBtn" aria-label="Add photo">${ICON.camera}</button>
    </div>
    <div class="container">
      ${dueReminders.length ? `<div class="tilerow" style="grid-template-columns:1fr;padding-top:12px">
        <button class="card tile" id="dueBanner" style="border-left:4px solid var(--red);text-align:left;padding:12px 14px">
          <span class="lbl" style="color:var(--red)">⚠ ${dueReminders.length} reminder${dueReminders.length > 1 ? 's' : ''} due</span>
          <div style="margin-top:4px;color:var(--ink-soft);font-size:14px">${esc(dueReminders.map((r) => r.title).join(', '))}</div>
        </button></div>` : ''}
      <div class="statgrid">
        <div class="col">
          <div class="card bigstat"><div class="num">${stats.avgMpg != null ? stats.avgMpg.toFixed(1) : '--'}</div><div class="lbl">Avg ${u.eff}</div></div>
          <div class="card bigstat"><div class="num">${stats.lastMpg != null ? stats.lastMpg.toFixed(1) : '--'}</div><div class="lbl">Last ${u.eff}</div></div>
          <div class="card bigstat"><div class="num">${stats.bestMpg != null ? stats.bestMpg.toFixed(1) : '--'}</div><div class="lbl">Best ${u.eff}</div></div>
        </div>
        <div class="col">
          <div class="card labelstat"><div class="lbl">Total ${u.distLong} Tracked</div><div class="num">${num(stats.milesTracked, 0)}</div></div>
          ${S.vehicle.track_city_hwy && stats.cityPct != null ? `
          <div class="card" style="flex:1;padding:12px 10px">
            <div class="lbl" style="color:var(--ink-soft);font-size:clamp(13px,3.6vw,16px);letter-spacing:.05em;text-transform:uppercase;padding:2px 4px 8px">City / Highway %</div>
            ${svgPie(stats.cityPct)}
            <div class="pielegend">
              <span><span class="dot" style="background:var(--orange)"></span>Highway</span>
              <span><span class="dot" style="background:var(--teal)"></span>City</span>
            </div>
          </div>` : ''}
        </div>
      </div>
      <div class="tilerow three">
        <div class="card tile"><div class="lbl">Fuel Logs</div><div class="num">${stats.fuelCount}</div></div>
        <div class="card tile"><div class="lbl">Total Fuel Cost</div><div class="num">${money(stats.totalFuelCost)}</div></div>
        <div class="card tile"><div class="lbl">Total ${u.fuelLong}</div><div class="num">${num(stats.totalGallons, 0)}</div></div>
      </div>
      <div class="tilerow two">
        <div class="card tile"><div class="lbl">Service Logs</div><div class="num">${stats.serviceCount}</div></div>
        <div class="card tile"><div class="lbl">Total Service Cost</div><div class="num">${money(stats.totalServiceCost)}</div></div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="container">
      <div class="sectiontitle">Fuel Efficiency</div>
      <div class="chartwrap">${svgLine(stats.mpgSeries, { labelFn: (t) => `${num(t, 0)} ${u.eff}` })}</div>
      ${stats.mpgSeries.length > 1 ? `<div class="chart-range"><span>${fmtDate(stats.mpgSeries[0].date)}</span><span>${fmtDate(stats.mpgSeries[stats.mpgSeries.length - 1].date)}</span></div>` : ''}
    </div>
    <div class="divider"></div>
    <div class="container">
      <div class="tilerow three" style="padding-top:14px">
        <div class="card tile"><div class="lbl">Avg. Price/${u.fuel === 'gal' ? 'Gallon' : 'Liter'}</div><div class="num">${money(stats.avgPricePerGal)}</div></div>
        <div class="card tile"><div class="lbl">Avg. Fuel-up Cost</div><div class="num">${money(stats.avgFuelupCost)}</div></div>
        <div class="card tile"><div class="lbl">Avg. Price/${u.dist === 'mi' ? 'Mile' : 'km'}</div><div class="num">${stats.avgPricePerMile != null ? money(stats.avgPricePerMile, 3) : '--'}</div></div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="container">
      <div class="sectiontitle">Fuelup Total Cost</div>
      <div class="chartwrap">${svgLine(stats.costSeries, { labelFn: (t) => money(t) })}</div>
      ${stats.costSeries.length > 1 ? `<div class="chart-range"><span>${fmtDate(stats.costSeries[0].date)}</span><span>${fmtDate(stats.costSeries[stats.costSeries.length - 1].date)}</span></div>` : ''}
      <button class="bigbtn" id="editVehicleBtn">Edit Vehicle Details</button>
    </div>`;

  $('#editVehicleBtn', view).onclick = () => vehicleForm(S.vehicle);
  $('#dueBanner', view) && ($('#dueBanner', view).onclick = () => { location.hash = '#/logs'; });
  $('#heroCamBtn', view).onclick = () => {
    const input = el('<input type="file" accept="image/*" hidden>');
    document.body.append(input);
    input.onchange = async () => {
      if (input.files[0]) {
        const data = await resizeImage(input.files[0]);
        await POST('/api/photos', { entity_type: 'vehicle', entity_id: S.vehicle.id, kind: 'photo', name: input.files[0].name, data });
        toast('Photo added');
        refresh();
      }
      input.remove();
    };
    input.click();
  };
}

function buildLogEntries(stats) {
  const u = units();
  const entries = [];
  for (const f of S.fuelups) {
    const mpg = stats.mpgById[f.id];
    entries.push({
      type: 'fuelup', date: f.date, obj: f, icon: ICON.fuel,
      title: fmtDate(f.date),
      sub: [`Fuelup${f.partial ? ' (partial)' : ''}`, f.gallons != null ? `${num(f.gallons, 3)} ${u.fuel}` : '', f.total_cost != null ? money(f.total_cost) : ''].filter(Boolean),
      badge: mpg != null ? { v: mpg.toFixed(1), unit: u.eff } : null,
      search: `fuelup ${f.location} ${f.notes} ${f.fuel_type} ${f.payment} ${f.odometer ?? ''} ${f.gallons ?? ''} ${f.total_cost ?? ''}`.toLowerCase(),
    });
  }
  for (const s of S.services) {
    const names = s.services ? JSON.parse(s.services) : [];
    entries.push({
      type: 'service', date: s.date, obj: s, icon: ICON.wrench,
      title: fmtDate(s.date),
      sub: [names.join(', ') || 'Service'],
      cost: s.total_cost != null ? money(s.total_cost) : '',
      search: `service ${names.join(' ')} ${s.location} ${s.notes} ${(s.tags ? JSON.parse(s.tags) : []).join(' ')} ${s.odometer ?? ''} ${s.total_cost ?? ''}`.toLowerCase(),
    });
  }
  for (const n of S.notes) {
    entries.push({
      type: 'note', date: n.date, obj: n, icon: ICON.note,
      title: fmtDate(n.date),
      sub: [n.title || (n.text || 'Note').slice(0, 60)],
      search: `note ${n.title} ${n.text}`.toLowerCase(),
    });
  }
  for (const r of S.reminders) {
    const due = reminderIsDue(r, stats.lastOdometer);
    entries.push({
      type: 'reminder', date: r.due_date || r.created_at, obj: r, icon: ICON.bell, due,
      title: r.due_date ? fmtDate(r.due_date) : 'No due date',
      sub: [`${r.done ? '✓ ' : due ? 'DUE — ' : ''}${r.title}`, r.due_odometer != null ? `at ${num(r.due_odometer, 0)} ${u.dist}` : ''].filter(Boolean),
      search: `reminder ${r.title} ${r.notes}`.toLowerCase(),
    });
  }
  entries.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return entries;
}

function renderLogs(view) {
  const stats = computeFuel();
  const u = units();
  const recent = stats.mpgSeries.slice(-10).map((p) => p.v);
  const filtersOff = Object.values(S.typeFilter).filter((v) => !v).length;

  view.innerHTML = `
    <div class="recentbar">
      <h2>Recent Fuel Efficiency</h2>
      <div class="side">
        <div class="lbl">BEST ${u.eff}</div>
        <div class="num">${stats.bestMpg != null ? stats.bestMpg.toFixed(1) : '--'}</div>
        <div class="lbl">LAST ${u.eff}</div>
        <div class="num">${stats.lastMpg != null ? stats.lastMpg.toFixed(1) : '--'}</div>
      </div>
      <div>${svgBars(recent)}</div>
    </div>
    <div class="searchrow">
      <div class="searchbox">${ICON.search}<input type="search" id="logSearch" placeholder="Search" value="${esc(S.search)}"></div>
      <button class="filterbtn" id="filterBtn">${ICON.sliders} FILTER ${filtersOff ? `<span class="fcount">${filtersOff}</span>` : ''}</button>
    </div>
    <div class="loglist" id="logList"></div>`;

  const list = $('#logList', view);
  const q = S.search.trim().toLowerCase();
  let entries = buildLogEntries(stats).filter((e) => S.typeFilter[e.type]);
  if (q) entries = entries.filter((e) => e.search.includes(q) || e.title.toLowerCase().includes(q));

  if (!entries.length) {
    list.innerHTML = `<div class="logempty">${S.fuelups.length || S.services.length ? 'No entries match your search.' : 'No logs yet.<br>Tap the <b>+</b> button to add your first fuelup.'}</div>`;
  }
  for (const e of entries) {
    const row = el(`<button class="logrow ${e.due ? 'due' : ''}">
      <span class="lico">${e.icon}</span>
      <span class="timeline"><span class="tdot"></span></span>
      <span class="lmain">
        <span class="ldate">${esc(e.title)}</span>
        <span class="lsub">${e.sub.map((s) => `<span class="t">${esc(s)}</span>`).join('')}</span>
      </span>
      ${e.badge ? `<span class="mpgbadge"><div class="v">${e.badge.v}</div><div class="u">${e.badge.unit}</div></span>`
        : e.cost ? `<span class="rcost">${esc(e.cost)}</span>` : '<span></span>'}
    </button>`);
    row.onclick = () => {
      ({ fuelup: fuelupForm, service: serviceForm, note: noteForm, reminder: reminderForm })[e.type](e.obj);
    };
    list.append(row);
  }

  $('#logSearch', view).oninput = (ev) => {
    S.search = ev.target.value;
    clearTimeout(renderLogs._t);
    renderLogs._t = setTimeout(() => renderLogs(view), 160);
  };
  $('#filterBtn', view).onclick = () => openSheet({
    title: 'Show log types',
    options: ['Fuelups', 'Services', 'Notes', 'Reminders'],
    selected: ['Fuelups', 'Services', 'Notes', 'Reminders'].filter((_, i) => S.typeFilter[['fuelup', 'service', 'note', 'reminder'][i]]),
    multi: true, allowCustom: false,
    onDone: (sel) => {
      const keys = { Fuelups: 'fuelup', Services: 'service', Notes: 'note', Reminders: 'reminder' };
      S.typeFilter = { fuelup: false, service: false, note: false, reminder: false };
      for (const s of sel) S.typeFilter[keys[s]] = true;
      store.set('typeFilter', S.typeFilter);
      renderLogs(view);
    },
  });
}

function renderWelcome(view) {
  view.innerHTML = `
    <div class="container" style="padding:60px 24px;text-align:center">
      <div style="color:var(--teal);margin:0 auto 18px;width:88px">${ICON.car}</div>
      <h2 style="font-size:24px;margin-bottom:10px">Welcome to GasTracker</h2>
      <p style="color:var(--ink-soft);line-height:1.6;margin-bottom:26px">
        Your personal fuel &amp; service log. All data stays on <b>your</b> server —
        no accounts, no cloud, no shutdown risk.</p>
      <button class="bigbtn" id="addFirstVehicle" style="width:auto;padding:15px 40px">Add Your First Vehicle</button>
    </div>`;
  $('#addFirstVehicle', view).onclick = () => vehicleForm(null);
}

function render() {
  const view = $('#view');
  $('#topbarTitle').textContent = S.vehicle ? S.vehicle.name : 'GasTracker';
  $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.route === S.route));
  if (!S.vehicle) { renderWelcome(view); return; }
  if (S.route === 'logs') renderLogs(view);
  else renderVehicleInfo(view);
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- drawer
function openDrawer() {
  const drawer = $('#drawer'), scrim = $('#drawerScrim');
  const active = S.vehicles.filter((v) => !v.retired);
  const retired = S.vehicles.filter((v) => v.retired);
  drawer.innerHTML = `
    <div class="drawerhead">
      <div class="appname">GasTracker</div>
      <div class="sub">Your fuel &amp; service log</div>
    </div>
    <div class="drawersec">
      <div class="dtitle">Vehicles</div>
      ${active.map((v) => `
        <button class="drawerbtn vehbtn ${S.vehicle && v.id === S.vehicle.id ? 'active' : ''}" data-id="${v.id}">
          ${ICON.car}<span>${esc(v.name)}<br><span class="vmeta">${esc([v.year, v.make, v.model].filter(Boolean).join(' '))}</span></span>
        </button>`).join('')}
      ${retired.map((v) => `
        <button class="drawerbtn vehbtn retired" data-id="${v.id}">
          ${ICON.eyeoff}<span>${esc(v.name)}<br><span class="vmeta">retired</span></span>
        </button>`).join('')}
      <button class="drawerbtn" id="drawerAddVehicle">${ICON.plus}<span>Add Vehicle</span></button>
    </div>
    <div class="drawersec">
      <div class="dtitle">Your Data</div>
      <button class="drawerbtn" id="drawerExport">${ICON.download}<span>Export Everything (JSON)</span></button>
      <button class="drawerbtn" id="drawerCsv">${ICON.download}<span>Export Fuelups (CSV)</span></button>
      <button class="drawerbtn" id="drawerImport">${ICON.upload}<span>Import Backup</span></button>
    </div>
    <div class="drawersec" style="border:0">
      <div class="dtitle">About</div>
      <div style="padding:6px 20px 16px;color:var(--ink-soft);font-size:13.5px;line-height:1.6">
        GasTracker is your own self-hosted app.<br>Data lives in <code>data/gastracker.db</code> on your server. Back it up by exporting or copying that folder.
      </div>
    </div>`;
  drawer.classList.remove('hidden');
  scrim.classList.remove('hidden');
  const close = () => { drawer.classList.add('hidden'); scrim.classList.add('hidden'); };
  scrim.onclick = close;
  $$('.vehbtn', drawer).forEach((b) => {
    b.onclick = async () => { close(); await setActiveVehicle(Number(b.dataset.id)); };
  });
  $('#drawerAddVehicle', drawer).onclick = () => { close(); vehicleForm(null); };
  $('#drawerExport', drawer).onclick = () => { close(); window.open('/api/export', '_blank'); };
  $('#drawerCsv', drawer).onclick = () => { close(); exportCsv(); };
  $('#drawerImport', drawer).onclick = () => {
    close();
    const input = el('<input type="file" accept="application/json" hidden>');
    document.body.append(input);
    input.onchange = async () => {
      try {
        const text = await input.files[0].text();
        if (!confirm('Import this backup? Entries will be ADDED to the current database (nothing is deleted).')) return;
        const counts = await POST('/api/import', JSON.parse(text));
        toast(`Imported: ${counts.vehicles} vehicles, ${counts.fuelups} fuelups, ${counts.services} services`);
        await loadVehicles();
        refresh();
      } catch (e) {
        toast('Import failed: ' + e.message);
      } finally {
        input.remove();
      }
    };
    input.click();
  };
}

function exportCsv() {
  if (!S.vehicle) return;
  const stats = computeFuel();
  const rows = [['date', 'odometer', 'gallons', 'cost_per_gal', 'total_cost', 'mpg', 'partial', 'missed', 'city_pct', 'fuel_type', 'location', 'payment', 'notes']];
  for (const f of [...S.fuelups].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    rows.push([f.date, f.odometer, f.gallons, f.cost_per_gal, f.total_cost,
      stats.mpgById[f.id]?.toFixed(2) ?? '', f.partial, f.missed, f.city_pct ?? '',
      f.fuel_type, f.location, f.payment, f.notes]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = el(`<a download="${esc(S.vehicle.name.replace(/[^\w-]+/g, '_'))}-fuelups.csv" href="${URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))}" hidden></a>`);
  document.body.append(a);
  a.click();
  a.remove();
}

async function setActiveVehicle(id) {
  S.vehicle = S.vehicles.find((v) => v.id === id) || S.vehicle;
  store.set('activeVehicleId', S.vehicle?.id ?? null);
  await refresh();
}

// ---------------------------------------------------------------- FAB + nav + init
function closeFabMenu() {
  $('#fabMenu').classList.add('hidden');
  $('#fabBtn').classList.remove('open');
}

function initChrome() {
  $('#menuBtn').onclick = openDrawer;
  $('#infoBtn').onclick = () => S.vehicle ? vehicleForm(S.vehicle) : vehicleForm(null);
  $$('.navbtn').forEach((b) => {
    b.onclick = () => { location.hash = '#/' + b.dataset.route; };
  });
  $('#fabBtn').onclick = () => {
    if (!S.vehicle) { vehicleForm(null); return; }
    const menu = $('#fabMenu');
    menu.classList.toggle('hidden');
    $('#fabBtn').classList.toggle('open', !menu.classList.contains('hidden'));
  };
  $('#fabMenu').onclick = (e) => { if (e.target === $('#fabMenu')) closeFabMenu(); };
  $$('.fabitem').forEach((b) => {
    b.onclick = () => {
      closeFabMenu();
      ({ fuelup: fuelupForm, service: serviceForm, note: noteForm, reminder: reminderForm })[b.dataset.add](null);
    };
  });
  window.addEventListener('hashchange', () => {
    S.route = location.hash.includes('logs') ? 'logs' : 'vehicle';
    render();
  });
  S.route = location.hash.includes('logs') ? 'logs' : 'vehicle';
}

(async function init() {
  initChrome();
  try {
    await loadVehicles();
    await loadVehicleData();
  } catch (e) {
    $('#view').innerHTML = `<div class="logempty">Could not reach the server.<br>${esc(e.message)}</div>`;
    return;
  }
  render();
})();
