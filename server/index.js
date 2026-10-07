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

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // The in-app contact form POSTs to the email relay directly from the
        // browser (the relay rejects server-to-server requests).
        'connect-src': ["'self'", 'https://formsubmit.co'],
        // History thumbnails / detail images are blob: object URLs.
        'img-src': ["'self'", 'data:', 'blob:'],
      },
    },
    // The email relay requires a Referer header to accept submissions;
    // Helmet's default (no-referrer) strips it. This restores the normal
    // browser behavior of sending just the origin cross-origin.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use(cors());

// OCR is CPU-expensive: throttle just this endpoint.
const ocrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // 30 scans per IP per window
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

// Languages the OCR endpoint supports (tesseract codes), with the matching
// MyMemory translation API codes.
const OCR_LANGS = {
  eng: { name: 'English', api: 'en' },
  spa: { name: 'Spanish', api: 'es' },
  kor: { name: 'Korean', api: 'ko' },
};

// Lazily-created, reused OCR workers — one per language, so each model
// loads only once no matter how many scans come in.
const workerPool = new Map();
function getWorker(lang) {
  const code = OCR_LANGS[lang] ? lang : 'eng';
  if (!workerPool.has(code)) {
    const p = createWorker(code).catch((err) => {
      workerPool.delete(code); // allow retry on next request
      throw err;
    });
    workerPool.set(code, p);
  }
  return workerPool.get(code);
}

const TRANSLATE_TIMEOUT_MS = 12000;

// Translate text to English via the free MyMemory API (no key needed).
// Never throws: on any failure we fall back to the original text and the
// caller flags the result so the UI can warn instead of silently trusting it.
async function translateToEnglish(text, lang) {
  if (lang === 'eng' || !text) return { textEn: text, translated: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const pair = `${OCR_LANGS[lang].api}|en`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`translate http ${res.status}`);
    const data = await res.json();
    const out = (data && data.responseData && data.responseData.translatedText || '').trim();
    if (!out) throw new Error('empty translation');
    return { textEn: out, translated: true };
  } catch (err) {
    console.warn('Translation to English failed:', err && err.message ? err.message : err);
    return { textEn: text, translated: false };
  } finally {
    clearTimeout(timer);
  }
}

// Translate allergy keywords into the label language so the client can ALSO
// match against the original (untranslated) OCR text — a safety net for when
// the full-text translation garbles an ingredient name. `groups` is
// [{id, label, terms}]; the terms are newline-joined into one batched call
// and split back. If the lines don't align 1:1 we return null (skip the
// safety net) rather than match against misaligned keywords.
async function translateKeywords(groups, lang) {
  if (lang === 'eng' || !groups.length) return null;
  const flat = [];
  const counts = [];
  for (const g of groups) {
    const terms = (g.terms || []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 12);
    counts.push(terms.length);
    flat.push(...terms);
  }
  if (!flat.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const pair = `en|${OCR_LANGS[lang].api}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(flat.join('\n'))}&langpair=${pair}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`translate http ${res.status}`);
    const data = await res.json();
    const out = (data && data.responseData && data.responseData.translatedText || '').trim();
    const lines = out.split('\n').map((s) => s.trim());
    if (lines.length !== flat.length) throw new Error('keyword alignment broke');
    const regrouped = [];
    let i = 0;
    groups.forEach((g, gi) => {
      regrouped.push({ id: g.id, label: g.label, terms: lines.slice(i, i + counts[gi]) });
      i += counts[gi];
    });
    return regrouped;
  } catch (err) {
    console.warn('Keyword translation failed:', err && err.message ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
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

// POST /api/ocr  (multipart form, fields: "image", optional "lang", optional "termGroups")
// "lang" is a tesseract code: eng (default), spa, kor.
// "termGroups" is JSON [{id, label, terms}] — the user's allergy keywords,
// translated into the label language so the client can also match the
// original text as a safety net. Response:
// { text, textEn, lang, translated, keywordGroups }
app.post('/api/ocr', ocrLimiter, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'NO_IMAGE' });
  }
  const lang = OCR_LANGS[req.body.lang] ? req.body.lang : OCR_LANGS[req.query.lang] ? req.query.lang : 'eng';
  let termGroups = [];
  try {
    const parsed = JSON.parse(req.body.termGroups || '[]');
    if (Array.isArray(parsed)) {
      termGroups = parsed
        .filter((g) => g && typeof g.id === 'string' && Array.isArray(g.terms))
        .slice(0, 60)
        .map((g) => ({ id: g.id, label: typeof g.label === 'string' ? g.label : g.id, terms: g.terms }));
    }
  } catch {
    // malformed termGroups -> just skip the keyword safety net
  }
  try {
    const worker = await getWorker(lang);
    const { data } = await worker.recognize(req.file.buffer);
    const text = (data.text || '').trim();
    const [{ textEn, translated }, keywordGroups] = await Promise.all([
      translateToEnglish(text, lang),
      translateKeywords(termGroups, lang),
    ]);
    res.json({ text, textEn, lang, translated, keywordGroups });
  } catch (err) {
    console.error('OCR failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'OCR_FAILED' });
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
  console.log(`EatFearless API listening on http://localhost:${PORT}`);
});

// Graceful shutdown: stop accepting connections, terminate the OCR worker,
// then exit. Docker sends SIGTERM on `docker stop`.
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => process.exit(0));
  // Don't hang forever if a scan is mid-flight.
  setTimeout(() => process.exit(1), 10000).unref();
  for (const p of workerPool.values()) {
    p.then((w) => w.terminate()).catch(() => {});
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
