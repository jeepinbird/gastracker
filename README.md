# GasTracker

A personal, self-hosted fuel & vehicle service tracker — a clone of the Gas Cubby
app, built so you can never lose access to your data. No accounts, no cloud, no
subscription, **zero dependencies**: just Node.js and this repo.

## Features

- **Vehicles** — name, year/make/model, VIN, engine, transmission, license plate,
  insurance policy, tire size/pressure, private notes. Retire or delete
  vehicles. Multiple vehicles supported.
- **Fuelups** — odometer, cost/gal, gallons, total cost (any third value is
  auto-calculated), partial & missed fuel-up handling, city-driving % slider,
  fuel type/octane, location, payment method, notes.
- **Services** — multi-select service types (oil change, tires, brakes, … plus
  your own), cost, location, tags, payment type, notes.
- **Reminders** — due by date and/or odometer with repeat intervals, flagged
  red when due.
- **Dashboard** — avg/last/best MPG, total miles tracked, city/highway pie,
  fuel & service cost totals, fuel-efficiency and fuel-cost charts,
  avg price/gallon, avg fuel-up cost, avg price/mile.
- **Logs** — combined searchable, filterable timeline of everything, with a
  recent-MPG bar chart and per-fuelup MPG badges.
- **Your data, always** — one-tap JSON export/import of everything, CSV export
  of fuelups, and the whole database is one SQLite file you can copy.
- **PWA** — installs to your phone's home screen and works across screen sizes.

## Running it

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite` — nothing to install).

```bash
node server.js
```

Open http://localhost:3000. That's it.

### Run with Docker (recommended for servers)

```bash
docker compose up -d
```

That builds the image, starts it in the background, restarts it on crashes
and reboots, and keeps your database in a named volume (`gastracker-data`).
Check on it with `docker compose logs -f`; update with
`git pull && docker compose up -d --build`.

To require a password, uncomment `GASTRACKER_PASSWORD` in
`docker-compose.yml`. Without compose, the equivalent is:

```bash
docker build -t gastracker .
docker run -d --name gastracker -p 3000:3000 \
  -v gastracker-data:/data --restart unless-stopped gastracker
```

**Backing up under Docker:** the JSON export in the app works as always, or
grab the database file straight from the volume:

```bash
docker cp gastracker:/data/gastracker.db ./gastracker-backup.db
```

### Options (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `GASTRACKER_PASSWORD` | *(off)* | Enable HTTP Basic auth (any username) |
| `GASTRACKER_DATA_DIR` | `./data` | Where the database lives |

### Install on your phone

1. Host the app somewhere your phone can reach (a home server, Raspberry Pi,
   a $4 VPS, Tailscale, etc.).
2. Open the URL in Safari (iOS) or Chrome (Android).
3. **Share → Add to Home Screen** (iOS) or **Install app** (Android).

It launches full-screen like a native app.

> **Exposing it to the internet?** Set `GASTRACKER_PASSWORD` and put it behind
> HTTPS (e.g. Caddy or a Tailscale/WireGuard network). iOS requires HTTPS for
> PWA installs from non-localhost hosts.

### Run as a service without Docker (systemd example)

```ini
[Unit]
Description=GasTracker
After=network.target

[Service]
WorkingDirectory=/opt/gastracker
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

## Your data

Everything lives in one SQLite database:

- `data/gastracker.db` (plus `-wal`/`-shm` journal files)

**Back up** by copying that file, or use **menu → Export Everything (JSON)**
for a plain-text backup. Import restores onto any fresh install.

## Migrating from Gas Cubby / Fuelly

Export your fuelups and services as CSV from the old app, then convert them:

```bash
node scripts/fuelly-convert.js civicfuelups.csv civicservices.csv \
  jeepfuelups.csv jeepservices.csv > import.json
```

Pass any number of fuelup/service CSVs — vehicles are created automatically
from the `car_name` column and merged across files. Then open the app and use
**menu → Import Backup** with the generated file. Partial and missed fuel-ups,
city %, brands (as locations), and notes all carry over ("bought the car"
entries become $0 service records); MPG is recomputed and matches Fuelly's
numbers.

## Development notes

- `server.js` — zero-dependency HTTP server + REST API (`/api/vehicles`,
  `/api/fuelups`, `/api/services`, `/api/reminders`, `/api/export`,
  `/api/import`)
- `db.js` — SQLite schema
- `public/` — vanilla-JS single-page app (no build step), hand-rolled SVG charts
- `scripts/make-icons.js` — regenerates the PWA icons (`npm run icons`)

MPG math follows the standard rules: a full fuel-up measures distance since the
last full fuel-up divided by all fuel added since then (partials roll forward);
a "missed" fuel-up resets the baseline so one forgotten stop doesn't corrupt
your stats.
