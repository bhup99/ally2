import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Behind the Caddy reverse proxy (one hop) so req.ip / rate limiting
// see the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '100kb' })); // JSON bodies for /api/feedback

// OCR is CPU-expensive: throttle just this endpoint.
const ocrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // 30 scans per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});

// Feedback is rare and cheap: a tight per-IP cap stops spam abuse.
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // 5 messages per IP per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});

// Accept a single image upload, held in memory (never written to disk).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('NOT_AN_IMAGE'));
  },
});

// Lazily-created, reused OCR worker (loads the English model once).
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng').catch((err) => {
      workerPromise = null; // allow retry on next request
      throw err;
    });
  }
  return workerPromise;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Digital Asset Links for the Google Play release (Trusted Web Activity).
// Lets the Play Store app open full-screen without a browser URL bar.
// After generating the Play package, set ASSETLINKS_SHA256 (comma-separated
// SHA-256 fingerprints) and ANDROID_PACKAGE in the environment — PWABuilder
// shows both values during packaging.
app.get('/.well-known/assetlinks.json', (_req, res) => {
  const fingerprints = (process.env.ASSETLINKS_SHA256 || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!fingerprints.length) {
    return res.status(404).json({ error: 'assetlinks_not_configured' });
  }
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: process.env.ANDROID_PACKAGE || 'app.allergyscanner.twa',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

// POST /api/ocr  (multipart form, field name: "image")
app.post('/api/ocr', ocrLimiter, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'NO_IMAGE' });
  }
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(req.file.buffer);
    res.json({ text: (data.text || '').trim() });
  } catch (err) {
    console.error('OCR failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'OCR_FAILED' });
  }
});

// POST /api/feedback  (JSON body: { name, title, description, extra, appVersion, device })
// Forwards the in-app contact form to the owner's email via a form-to-email
// relay. Done server-side because the browser Content-Security-Policy only
// allows same-origin requests — the client can't reach the relay directly.
const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'bhupeshkushwah99@gmail.com';

app.post('/api/feedback', feedbackLimiter, async (req, res) => {
  const { name, title, description, extra, appVersion, device } = req.body || {};
  if (
    typeof title !== 'string' || !title.trim() ||
    typeof description !== 'string' || !description.trim()
  ) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }
  const clean = (s, max) => String(s || '').slice(0, max);
  try {
    const upstream = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_EMAIL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        _subject: `Allergy Scanner feedback: ${clean(title, 120).trim()}`,
        _template: 'table',
        _captcha: 'false',
        Name: clean(name, 80).trim() || '(not given)',
        'Issue title': clean(title, 120).trim(),
        Description: clean(description, 4000).trim(),
        'Anything else': clean(extra, 2000).trim() || '—',
        'App version': clean(appVersion, 20),
        Device: clean(device, 220),
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || String(data.success) === 'false') {
      console.error('Feedback relay rejected:', data.message || upstream.status);
      return res.status(502).json({ error: 'RELAY_FAILED' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Feedback relay error:', err && err.message ? err.message : err);
    res.status(502).json({ error: 'RELAY_FAILED' });
  }
});

// Multer / upload errors -> clean JSON responses.
app.use((err, _req, res, next) => {
  if (err.message === 'NOT_AN_IMAGE') {
    return res.status(400).json({ error: 'NOT_AN_IMAGE' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'FILE_TOO_LARGE' });
  }
  next(err);
});

// In production, serve the built React client from a single process.
const distDir = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next(); // no dist built yet -> fall through to 404
  });
});

const server = app.listen(PORT, () => {
  console.log(`Allergy Scanner API listening on http://localhost:${PORT}`);
});

// Graceful shutdown: stop accepting connections, terminate the OCR worker,
// then exit. Docker sends SIGTERM on `docker stop`.
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => process.exit(0));
  // Don't hang forever if a scan is mid-flight.
  setTimeout(() => process.exit(1), 10000).unref();
  if (workerPromise) {
    workerPromise.then((w) => w.terminate()).catch(() => {});
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
