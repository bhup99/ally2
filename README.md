# Allergy Scanner — React + Node rebuild

A lightweight, no-account web app: photograph an ingredient label, OCR the
text server-side, and check it against your saved allergy list.

- **Client:** React (Vite), mobile-first. Allergy list lives in
  `localStorage` — no accounts, no database.
- **Server:** Node.js + Express. One job: accept an image upload, run OCR
  with tesseract.js, return the extracted text as JSON.

## Prerequisites

- Node.js 18+ (tested on Node 24)
- npm 9+
- Internet access on first OCR run (tesseract.js downloads the English
  language model once, then caches it)

## Install

```bash
# backend
cd server && npm install

# frontend
cd ../client && npm install
```

## Run (development)

Terminal 1 — API server (http://localhost:3001):

```bash
cd server
npm run dev
```

Terminal 2 — web app (http://localhost:5173, proxies `/api` to the server):

```bash
cd client
npm run dev
```

Open http://localhost:5173 on your phone's browser (same Wi-Fi) or desktop.

## Run (production build)

```bash
cd client && npm run build
cd ../server && npm start
```

The server serves the built client from `client/dist`, so a single process
on http://localhost:3001 runs the whole app. Set `PORT` to change it:

```bash
PORT=8080 npm start
```

## API

- `GET /api/health` → `{ "ok": true }`
- `POST /api/ocr` — multipart form with an `image` field (any image type,
  ≤ 10 MB) → `{ "text": "..." }`
  - `400 { "error": "NO_IMAGE" }` — no file attached
  - `400 { "error": "NOT_AN_IMAGE" }` — file isn't an image
  - `400 { "error": "FILE_TOO_LARGE" }` — over 10 MB
  - `500 { "error": "OCR_FAILED" }` — recognition failed

## How matching works

Matching is client-side in `client/src/lib/matcher.js`. Each allergen has a
synonym/derivative map (e.g. peanut → groundnut, arachis; milk → whey,
casein, lactose; gluten → wheat, barley, rye, malt). Terms are matched
case-insensitively on word boundaries, so "peanut" matches but "peanut"
inside a longer word does not — conservative by design, to avoid false alarms.

## Project layout

```
allergy-scanner-react-node/
  client/                 # React + Vite frontend
    src/
      data/allergens.js   # built-in allergen list + synonym map
      lib/matcher.js      # ingredient matching logic
      App.jsx             # screens: Home / Allergies / Scan / Result
      main.jsx, styles.css
  server/
    index.js              # Express API + OCR endpoint (+ serves client/dist)
```

## Privacy

No accounts, no tracking, no database. Your allergy list stays in your
browser's localStorage. Uploaded label photos are processed in memory and
never stored.

## Production

What you need: a domain name (e.g. `scanner.example.com`) pointing at any
VPS or container host — Hetzner, DigitalOcean, Render, Fly.io, etc. Caddy
fetches and renews the HTTPS certificate automatically.

Deploy:

```bash
cd allergy-scanner-react-node
DOMAIN=scanner.example.com docker compose up --build -d
```

That's it: the image builds the React client, installs only server
dependencies, bakes the English OCR model in (no download on first request),
and Caddy terminates HTTPS in front of the app. Open
`https://scanner.example.com` on your phone — mobile browsers require HTTPS
for camera access, which is why the domain + Caddy matter.

Useful commands:

```bash
docker compose logs -f          # live logs (app + Caddy)
docker compose logs -f app       # app logs only
docker compose ps               # container status / health
```

Update to a new version:

```bash
git pull                        # or copy the new code over
DOMAIN=scanner.example.com docker compose up --build -d
```

Notes:

- **Nothing to back up server-side.** Allergy lists live in each user's
  browser localStorage and scan history (downscaled label photos + results)
  lives in the browser's IndexedDB — both on-device only, and the user can
  delete history from the app's History screen. Uploaded photos are processed
  in memory and never stored on the server. The only server state is Caddy's
  certificate data (in a Docker volume, recreated automatically if lost).
- **First boot is fast.** The OCR language model is baked into the image at
  build time; the only first-request cost is loading tesseract into memory
  (a few seconds).
- **Abuse protection.** `/api/ocr` is rate-limited to 30 scans per 15
  minutes per IP (OCR is CPU-heavy); security headers come from helmet, and
  Express trusts the single Caddy proxy hop for correct client IPs.
- The app is installable: it ships a web manifest, theme color, and home
  screen icons, so phones offer "Add to Home Screen" / "Install app".

## Manual test checklist (scan history)

IndexedDB can't be exercised from Node, so verify in a real browser:

1. Open the app, add an allergy, and scan a label photo → the result screen
   appears normally (history saves in the background, it never blocks this).
2. Go to **Home → Scan history** → the scan is listed, newest first, with a
   thumbnail, date/time, and a verdict badge.
3. Tap the row → the detail view shows the same verdict banner, the label
   photo, and the extracted text with matches highlighted.
4. Reload the page (or close and reopen the installed app) → the history is
   still there.
5. Delete one entry with the 🗑 button → it disappears; reload → it stays gone.
6. Tap **Clear all history** → confirm the dialog → the list empties.
7. Scan a photo the OCR can't read → a "Read failed" entry is saved honestly.
8. Paste typed ingredients and check them → a history entry is saved without
   a photo (📄 placeholder thumbnail).
