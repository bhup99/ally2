import { useEffect, useMemo, useRef, useState } from 'react';
import { ALLERGENS } from './data/allergens.js';
import { findMatches, matchedLabels } from './lib/matcher.js';
import { saveScan, listScans, deleteScan, clearScans } from './lib/db.js';
import { downscaleImage } from './lib/image.js';

const STORAGE_KEY = 'allergy-scanner:v1';
const OCR_TIMEOUT_MS = 90000;

// Bump this on every release. It drives the header badge, the one-time
// deploy confirmation, and the console launch log.
const APP_VERSION = '1.2.8';

// Public support address shown on the home screen "Contact us" button.
const SUPPORT_EMAIL = 'bhupeshkushwah99@gmail.com';

function loadAllergyState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { selected: [], custom: [] };
    const parsed = JSON.parse(raw);
    return {
      selected: Array.isArray(parsed.selected) ? parsed.selected : [],
      custom: Array.isArray(parsed.custom) ? parsed.custom : [],
    };
  } catch {
    return { selected: [], custom: [] };
  }
}

function allAllergens(custom) {
  return [...ALLERGENS, ...custom];
}

/* Verdicts stored on history entries:
   'contains-allergen' | 'no-match' | 'no-allergies-saved' | 'failed' */
function computeVerdict(matches, selectedCount) {
  if (selectedCount === 0) return 'no-allergies-saved';
  return matches.length > 0 ? 'contains-allergen' : 'no-match';
}

function newScanId() {
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const VERDICT_BADGES = {
  'contains-allergen': { label: 'Contains allergen', cls: 'vbadge danger' },
  'no-match': { label: 'No match', cls: 'vbadge safe' },
  'no-allergies-saved': { label: 'Not checked', cls: 'vbadge neutral' },
  failed: { label: 'Read failed', cls: 'vbadge muted' },
};

/* Re-check a stored history entry against the CURRENT allergy list, so old
   entries stay truthful as the user adds more allergies. The stored verdict
   remains the scan-time record; `changed` flags when the live result
   differs from it. */
function liveCheck(entry, selected, custom) {
  if (!entry.extractedText) {
    return { verdict: 'failed', labels: [], matches: [], changed: false };
  }
  const matches = findMatches(entry.extractedText, selected, custom);
  const labels = [...new Set(matches.map((m) => m.label))];
  const verdict = computeVerdict(matches, selected.length + custom.length);
  return { verdict, labels, matches, changed: verdict !== entry.verdict };
}

/* ------------------------------ small pieces ------------------------------ */

function Header({ title, onBack, onHome }) {
  return (
    <header className="topbar">
      {onBack ? (
        <button className="iconbtn" onClick={onBack} aria-label="Back">
          ←
        </button>
      ) : (
        <span className="spacer" />
      )}
      <h1>
        {title} <span className="ver">v{APP_VERSION}</span>
      </h1>
      {onHome ? (
        <button className="homebtn" onClick={onHome} aria-label="Go to home screen">
          🏠 Home
        </button>
      ) : (
        <span className="spacer" />
      )}
    </header>
  );
}

function HighlightedText({ text, matches }) {
  const parts = useMemo(() => {
    if (!matches.length) return null;
    const out = [];
    let pos = 0;
    matches.forEach((m, i) => {
      if (m.index > pos) out.push(<span key={`t${i}`}>{text.slice(pos, m.index)}</span>);
      out.push(<mark key={`m${i}`}>{text.slice(m.index, m.index + m.length)}</mark>);
      pos = m.index + m.length;
    });
    if (pos < text.length) out.push(<span key="tail">{text.slice(pos)}</span>);
    return out;
  }, [text, matches]);

  return <p className="extracted">{parts ?? text}</p>;
}

function VerdictBanner({ verdict, labels, selectedCount }) {
  if (verdict === 'contains-allergen') {
    return (
      <div className="banner danger">
        <h2>⚠️ Contains allergen{labels.length > 1 ? 's' : ''}</h2>
        <p>{labels.join(', ')}</p>
      </div>
    );
  }
  if (verdict === 'no-match') {
    return (
      <div className="banner safe">
        <h2>✅ No matches found</h2>
        <p>
          None of your {selectedCount} saved{' '}
          {selectedCount === 1 ? 'allergy was' : 'allergies were'} detected.
        </p>
      </div>
    );
  }
  if (verdict === 'failed') {
    return (
      <div className="banner neutral">
        <h2>Couldn't read the label</h2>
        <p>No text was extracted from this photo.</p>
      </div>
    );
  }
  return (
    <div className="banner neutral">
      <h2>No allergies saved yet</h2>
      <p>Here's the text we found — add your allergies to check it automatically.</p>
    </div>
  );
}

function Thumb({ blob }) {
  const [url, setUrl] = useState(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!(blob instanceof Blob) || blob.size === 0) return;
    let u;
    try {
      u = URL.createObjectURL(blob);
    } catch {
      setBroken(true);
      return;
    }
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  if (!(blob instanceof Blob) || blob.size === 0 || broken)
    return <div className="thumb placeholder" aria-hidden="true">📄</div>;
  if (!url) return <div className="thumb placeholder" aria-hidden="true" />;
  return <img className="thumb" src={url} alt="" onError={() => setBroken(true)} />;
}

/* --------------------------------- screens --------------------------------- */

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as MacIntel — maxTouchPoints distinguishes it.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true // iOS Safari
  );
}

// iOS Safari never shows an automatic "install" prompt, so iPhone visitors
// get a short guide instead. Dismissible; hidden once installed.
function IOSInstallHint() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('ios-install-hint-dismissed') === '1';
    } catch {
      return true;
    }
  });
  if (!isIOS() || isStandalone() || dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem('ios-install-hint-dismissed', '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };
  return (
    <div className="card">
      <h3>📲 On iPhone? Install the app</h3>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: '0.95rem', lineHeight: 1.5 }}>
        <li>Tap the <b>Share</b> button in Safari (square with an arrow)</li>
        <li>Tap <b>Add to Home Screen</b></li>
        <li>Tap <b>Add</b> — done</li>
      </ol>
      <button className="ghostbtn" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}

function HomeScreen({ selectedCount, onAddAllergies, onScan, onHistory, onContact }) {
  return (
    <div className="screen">
      <div className="hero">
        <div className="logo">🔍</div>
        <h2>Allergy Scanner</h2>
        <p className="muted">Scan a label, spot your allergens. No account needed.</p>
      </div>
      <div className="stack">
        <button className="bigbtn primary" onClick={onAddAllergies}>
          ➕ Add allergies
          {selectedCount > 0 && <span className="badge">{selectedCount}</span>}
        </button>
        <button className="bigbtn secondary" onClick={onScan}>
          📷 Scan ingredients
        </button>
        <button className="ghostbtn" onClick={onHistory}>
          🕘 Scan history
        </button>
      </div>
      {selectedCount === 0 && (
        <p className="hint">Tip: add your allergies first — or scan right away and add them later.</p>
      )}
      <IOSInstallHint />
      <InstallFooter />
      <ContactFooter onContact={onContact} />
    </div>
  );
}

// Permanent install instructions at the bottom of the home page —
// how to save the site as an app for quick visits on Android and iPhone.
function InstallFooter() {
  return (
    <footer className="installfooter">
      <h3>📲 Save this as an app</h3>
      <p>
        <b>Android (Chrome):</b> tap the <b>⋮</b> menu →{' '}
        <b>Add to Home screen</b> (or <b>Install app</b>) → Add.
      </p>
      <p>
        <b>iPhone (Safari):</b> tap <b>Share</b> (square with an arrow) →{' '}
        <b>Add to Home Screen</b> → Add.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        It then opens full-screen from your home screen, just like a native app.
      </p>
    </footer>
  );
}

// Contact button at the bottom of the home page — opens the in-app
// contact form (no email app involved).
function ContactFooter({ onContact }) {
  return (
    <footer className="contactfooter">
      <button className="contactlink" onClick={onContact}>
        💬 Contact us
      </button>
      <p className="muted">Questions, issues, or ideas? We'd love to hear from you.</p>
    </footer>
  );
}

// In-app contact form. Sends the message to SUPPORT_EMAIL via a form-to-email
// relay — the user never leaves the app and no email app is opened.
// Only what the user types (plus app version + device type, disclosed below)
// is sent. Nothing is required except the title and description.
function ContactScreen({ onBack, onHome }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [extra, setExtra] = useState('');
  const [honey, setHoney] = useState(''); // spam trap — humans never fill this
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error

  const deviceInfo = () => {
    try {
      const ua = navigator.userAgent || '';
      const platform = /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : 'Desktop/other';
      return `${platform} — ${ua.slice(0, 140)}`;
    } catch {
      return 'unknown';
    }
  };

  const mailtoFallback =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent(`Allergy Scanner feedback: ${title.trim() || '…'}`)}` +
    `&body=${encodeURIComponent(
      `Name: ${name.trim() || '(not given)'}\n\n${description.trim()}\n\nAnything else: ${extra.trim() || '—'}`
    )}`;

  const submit = async (e) => {
    e.preventDefault();
    if (honey) {
      setStatus('sent'); // bot — pretend it worked
      return;
    }
    if (!title.trim() || !description.trim() || status === 'sending') return;
    setStatus('sending');
    try {
      // Direct browser POST: the relay rejects server-to-server requests, and
      // the Content-Security-Policy allows this origin (see server/index.js).
      const res = await fetch(`https://formsubmit.co/ajax/${SUPPORT_EMAIL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: `Allergy Scanner feedback: ${title.trim()}`,
          _template: 'table',
          _captcha: 'false',
          Name: name.trim() || '(not given)',
          'Issue title': title.trim(),
          Description: description.trim(),
          'Anything else': extra.trim() || '—',
          'App version': APP_VERSION,
          Device: deviceInfo(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || String(data.success) === 'false') {
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      setStatus('sent');
    } catch (err) {
      console.error('Feedback send failed:', err);
      setStatus('error');
    }
  };

  return (
    <div className="screen">
      <Header title="Contact us" onBack={onBack} onHome={onHome} />
      {status === 'sent' ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>✅ Message sent</h3>
          <p className="muted">
            Thanks{name.trim() ? `, ${name.trim()}` : ''}! Your message is on its
            way — we'll take a look soon.
          </p>
          <button className="bigbtn primary" onClick={onHome}>
            🏠 Back to home
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div>
            <label className="fieldlabel" htmlFor="contact-name">
              Your name <span className="muted">(optional)</span>
            </label>
            <input
              id="contact-name"
              className="field"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What should we call you?"
              autoComplete="name"
            />
          </div>
          <div>
            <label className="fieldlabel" htmlFor="contact-title">
              Title
            </label>
            <input
              id="contact-title"
              className="field"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. App crashes when I scan"
              required
            />
          </div>
          <div>
            <label className="fieldlabel" htmlFor="contact-desc">
              Describe the issue
            </label>
            <textarea
              id="contact-desc"
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened? What were you trying to do?"
              required
            />
          </div>
          <div>
            <label className="fieldlabel" htmlFor="contact-extra">
              Anything else you'd like to share{' '}
              <span className="muted">(optional)</span>
            </label>
            <textarea
              id="contact-extra"
              className="textarea"
              style={{ minHeight: 70 }}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="e.g. your phone model, or a way to reach you if you'd like a reply"
            />
          </div>
          {/* Spam trap — hidden from humans */}
          <input
            type="text"
            value={honey}
            onChange={(e) => setHoney(e.target.value)}
            style={{ display: 'none' }}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
          />
          <p className="rechecknote">
            Only what you type here is sent to the app maker by email — plus
            your app version and device type to help fix bugs. Your allergy
            list and scan history stay on your device. Nothing else is asked
            for or collected.
          </p>
          {status === 'error' && (
            <div className="card error" role="alert">
              <h3>Couldn't send that</h3>
              <p className="muted">
                Something went wrong sending your message. You can also email
                us directly:{' '}
                <a href={mailtoFallback}>{SUPPORT_EMAIL}</a>
              </p>
            </div>
          )}
          <button
            className="bigbtn primary"
            type="submit"
            disabled={status === 'sending' || !title.trim() || !description.trim()}
          >
            {status === 'sending' ? 'Sending…' : '📨 Send feedback'}
          </button>
        </form>
      )}
    </div>
  );
}

// One-time "new version deployed" confirmation. Shows once per APP_VERSION
// (tracked in localStorage) and logs to the console on every launch.
function DeployNote() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    console.log(
      `%c[Allergy Scanner] v${APP_VERSION} — deployed from GitHub`,
      'color:#0e7c66;font-weight:bold'
    );
    let seen = false;
    try {
      const key = `allergy-scanner:deploy-note:${APP_VERSION}`;
      seen = localStorage.getItem(key) === '1';
      if (!seen) localStorage.setItem(key, '1');
    } catch {
      seen = true; // storage unavailable — don't nag
    }
    if (!seen) {
      setVisible(true);
      const t = setTimeout(() => setVisible(false), 9000);
      return () => clearTimeout(t);
    }
  }, []);

  if (!visible) return null;
  return (
    <div className="deploynote" role="status">
      <span>✅ New version deployed (v{APP_VERSION})</span>
      <button className="deploynote-x" onClick={() => setVisible(false)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

function AllergiesScreen({ selected, custom, onToggle, onAddCustom, onBack, onHome }) {
  const [query, setQuery] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [customSynonyms, setCustomSynonyms] = useState('');

  const list = allAllergens(custom);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter(
        (a) =>
          a.label.toLowerCase().includes(q) ||
          a.terms.some((t) => t.toLowerCase().includes(q))
      )
    : list;

  const addCustom = () => {
    const label = customLabel.trim();
    if (!label) return;
    const terms = [
      label.toLowerCase(),
      ...customSynonyms
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ];
    onAddCustom({ id: `custom-${Date.now()}`, label, terms });
    setCustomLabel('');
    setCustomSynonyms('');
    setQuery('');
  };

  return (
    <div className="screen">
      <Header title="Your allergies" onBack={onBack} onHome={onHome} />
      <input
        className="search"
        type="search"
        placeholder="Search allergens…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="chips">
        {filtered.map((a) => {
          const active = selected.includes(a.id);
          return (
            <button
              key={a.id}
              className={`chip${active ? ' on' : ''}`}
              onClick={() => onToggle(a.id)}
              aria-pressed={active}
            >
              {active ? '✓ ' : ''}{a.label}
            </button>
          );
        })}
        {filtered.length === 0 && <p className="muted">No matches — add it as a custom allergy below.</p>}
      </div>
      <div className="card">
        <h3>Add your own</h3>
        <input
          className="field"
          placeholder="Allergy name (e.g. Kiwi)"
          value={customLabel}
          onChange={(e) => setCustomLabel(e.target.value)}
        />
        <input
          className="field"
          placeholder="Other words to match, comma-separated (optional)"
          value={customSynonyms}
          onChange={(e) => setCustomSynonyms(e.target.value)}
        />
        <button className="btn" onClick={addCustom} disabled={!customLabel.trim()}>
          Add custom allergy
        </button>
      </div>
      <p className="hint">Selections save automatically on this device.</p>
      <button className="bigbtn primary" onClick={onBack}>
        Done{selected.length > 0 ? ` (${selected.length})` : ''}
      </button>
    </div>
  );
}

function ScanScreen({ onResult, onFailed, onBack, onHome }) {
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState('idle'); // idle | reading | error
  const [errorKind, setErrorKind] = useState(null); // failed | empty
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const checkText = (text, source, file) => {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      setStatus('error');
      setErrorKind('empty');
      return;
    }
    onResult(trimmed, source, file || null);
  };

  const handleFile = async (file) => {
    if (!file) return;
    setStatus('reading');
    setErrorKind(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch('/api/ocr', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'OCR_FAILED');
      const text = (data.text || '').trim();
      if (!text) {
        setStatus('error');
        setErrorKind('empty');
        onFailed(file);
        return;
      }
      checkText(text, 'photo', file);
    } catch {
      setStatus('error');
      setErrorKind('failed');
      onFailed(file);
    } finally {
      clearTimeout(timer);
      if (fileRef.current) fileRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
    }
  };

  return (
    <div className="screen">
      <Header title="Scan ingredients" onBack={onBack} onHome={onHome} />
      <div className="stack">
        {/* Library / file picker — no `capture`, so the OS offers the
            photo picker instead of jumping straight to the camera. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="filehidden"
          id="photo-input"
          onChange={(e) => handleFile(e.target.files && e.target.files[0])}
        />
        {/* Camera — `capture` hints the browser to open the camera directly. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="filehidden"
          id="camera-input"
          onChange={(e) => handleFile(e.target.files && e.target.files[0])}
        />
        <label htmlFor="camera-input" className="bigbtn primary">
          📷 Take photo
        </label>
        <label htmlFor="photo-input" className="bigbtn secondary">
          🖼️ Choose from library
        </label>

        {status === 'reading' && (
          <div className="card reading" role="status">
            <div className="spinner" />
            <p>Reading the label…</p>
          </div>
        )}

        {status === 'error' && (
          <div className="card error" role="alert">
            <h3>We couldn't read the label.</h3>
            <p className="muted">
              {errorKind === 'empty'
                ? 'No text was found in that photo. Try a closer, well-lit shot — or paste the ingredients below.'
                : 'Text recognition could not finish. Try another photo, or paste the ingredient list below.'}
            </p>
            <label htmlFor="photo-input" className="btn">
              Try another photo
            </label>
          </div>
        )}

        <div className="divider">or</div>

        <label className="fieldlabel" htmlFor="typed-ingredients">
          Paste or type the ingredient list
        </label>
        <textarea
          id="typed-ingredients"
          className="textarea"
          rows={5}
          placeholder="Ingredients: wheat flour, sugar, whey powder…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button className="bigbtn secondary" onClick={() => checkText(typed, 'text')}>
          Check ingredients
        </button>
      </div>
    </div>
  );
}

function ResultScreen({ text, matches, selectedCount, onScanAgain, onEditAllergies, onHome }) {
  const labels = matchedLabels(matches);
  const hasAllergies = selectedCount > 0;

  return (
    <div className="screen">
      <Header title="Result" onBack={onScanAgain} onHome={onHome} />
      <VerdictBanner
        verdict={computeVerdict(matches, selectedCount)}
        labels={labels}
        selectedCount={selectedCount}
      />
      {labels.length > 0 && (
        <div className="matchchips">
          {labels.map((l) => (
            <span key={l} className="matchchip">⚠️ {l}</span>
          ))}
        </div>
      )}
      <h3 className="sectiontitle">Label text</h3>
      <div className="card">
        <HighlightedText text={text} matches={matches} />
      </div>
      <div className="stack">
        <button className="bigbtn secondary" onClick={onScanAgain}>
          🔄 Scan again
        </button>
        <button className="bigbtn primary" onClick={onEditAllergies}>
          ✏️ {hasAllergies ? 'Edit allergies' : 'Add allergies'}
        </button>
      </div>
    </div>
  );
}

function HistoryScreen({ selected, custom, onBack, onOpen, onHome }) {
  const [entries, setEntries] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listScans()
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const removeEntry = (id) => {
    deleteScan(id).catch((err) => console.error('Could not delete scan:', err));
    setEntries((prev) => (prev || []).filter((e) => e.id !== id));
  };

  const clearAll = () => {
    if (!window.confirm('Delete all scan history from this device? This cannot be undone.')) return;
    clearScans().catch((err) => console.error('Could not clear scan history:', err));
    setEntries([]);
  };

  return (
    <div className="screen">
      <Header title="Scan history" onBack={onBack} onHome={onHome} />
      {entries === null && !loadError && <p className="muted">Loading…</p>}
      {loadError && (
        <div className="card error" role="alert">
          <h3>Couldn't load history</h3>
          <p className="muted">Your browser's storage isn't available right now.</p>
        </div>
      )}
      {entries !== null && entries.length === 0 && (
        <div className="empty">
          <p className="muted">No scans yet. Scan a label and it'll show up here.</p>
        </div>
      )}
      {entries !== null && entries.length > 0 && (
        <>
          <div className="historylist">
            {entries.map((e) => {
              const live = liveCheck(e, selected, custom);
              const badge = VERDICT_BADGES[live.verdict] || VERDICT_BADGES.failed;
              return (
                <div key={e.id} className="historyrowwrap">
                  <button
                    className="historyrow"
                    onClick={() => onOpen(e)}
                    aria-label={`Open scan from ${new Date(e.timestamp).toLocaleString()}`}
                  >
                    <Thumb blob={e.image} />
                    <span className="hmeta">
                      <span className="hdate">
                        {new Date(e.timestamp).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                        {' · '}
                        {new Date(e.timestamp).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className={badge.cls}>{badge.label}</span>
                    </span>
                  </button>
                  <button
                    className="deletebtn"
                    onClick={() => removeEntry(e.id)}
                    aria-label="Delete this scan"
                  >
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
          <button className="btn danger" onClick={clearAll}>
            Clear all history
          </button>
          <p className="hint">History is stored only on this device.</p>
        </>
      )}
    </div>
  );
}

function HistoryDetailScreen({ entry, selected, custom, onBack, onHome }) {
  const [imgUrl, setImgUrl] = useState(null);
  const [imgBroken, setImgBroken] = useState(false);

  // Re-check against the current allergy list — the stored verdict is the
  // scan-time record, the banner below is the live one.
  const live = liveCheck(entry, selected, custom);
  const currentCount = selected.length + custom.length;
  const oldBadge = VERDICT_BADGES[entry.verdict] || VERDICT_BADGES.failed;

  useEffect(() => {
    setImgBroken(false);
    setImgUrl(null);
    if (!(entry.image instanceof Blob) || entry.image.size === 0) return;
    let u;
    try {
      u = URL.createObjectURL(entry.image);
    } catch {
      setImgBroken(true);
      return;
    }
    setImgUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [entry]);

  return (
    <div className="screen">
      <Header title="Scan details" onBack={onBack} onHome={onHome} />
      <p className="muted">
        {new Date(entry.timestamp).toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })}
        {' · '}
        {new Date(entry.timestamp).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        })}
      </p>
      <VerdictBanner
        verdict={live.verdict}
        labels={live.labels}
        selectedCount={currentCount}
      />
      {live.changed && (
        <div className="banner warn" role="note">
          <h2>Result changed since scan</h2>
          <p>
            This showed “{oldBadge.label}” when you scanned it. Your allergy
            list has changed since — the result above uses your current list.
          </p>
        </div>
      )}
      {live.labels.length > 0 && (
        <div className="matchchips">
          {live.labels.map((l) => (
            <span key={l} className="matchchip">⚠️ {l}</span>
          ))}
        </div>
      )}
      <p className="rechecknote">
        Re-checked against your current allergy list ({currentCount}{' '}
        {currentCount === 1 ? 'allergy' : 'allergies'}).
      </p>
      {imgUrl && !imgBroken && (
        <img
          className="detailimg"
          src={imgUrl}
          alt="Scanned label"
          onError={() => setImgBroken(true)}
        />
      )}
      {entry.extractedText ? (
        <>
          <h3 className="sectiontitle">Label text</h3>
          <div className="card">
            <HighlightedText text={entry.extractedText} matches={live.matches} />
          </div>
        </>
      ) : (
        <div className="card">
          <p className="muted">No text was extracted from this scan.</p>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------- app ----------------------------------- */

export default function App() {
  const [screen, setScreen] = useState('home');
  const [allergyState, setAllergyState] = useState(loadAllergyState);
  const [result, setResult] = useState(null); // { text, source }
  const [detailEntry, setDetailEntry] = useState(null);

  // Persist allergies immediately on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(allergyState));
    } catch {
      /* storage unavailable — app still works for the session */
    }
  }, [allergyState]);

  const toggle = (id) =>
    setAllergyState((s) => ({
      ...s,
      selected: s.selected.includes(id)
        ? s.selected.filter((x) => x !== id)
        : [...s.selected, id],
    }));

  const addCustom = (entry) =>
    setAllergyState((s) => ({
      custom: [...s.custom, entry],
      selected: [...s.selected, entry.id],
    }));

  // Save a scan to on-device history. Fire and forget: never blocks the UI.
  // Total saved allergies, including custom ones.
  const allergyCount = allergyState.selected.length + allergyState.custom.length;
  const goHome = () => setScreen('home');

  const persistScan = ({ text, source, file, matches, selectedCount, failed }) => {
    const entry = {
      id: newScanId(),
      timestamp: Date.now(),
      source,
      image: null,
      extractedText: text,
      matchedAllergens: matchedLabels(matches),
      matches,
      selectedCount,
      verdict: failed ? 'failed' : computeVerdict(matches, selectedCount),
    };
    (async () => {
      try {
        if (file) {
          try {
            entry.image = await downscaleImage(file);
          } catch (imgErr) {
            console.warn('Could not downscale scan image for history:', imgErr);
          }
        }
        await saveScan(entry);
      } catch (err) {
        console.error('Could not save scan to history:', err);
      }
    })();
  };

  const handleResult = (text, source, file) => {
    const m = findMatches(text, allergyState.selected, allergyState.custom);
    setResult({ text, source });
    setScreen('result');
    persistScan({
      text,
      source,
      file: file || null,
      matches: m,
      selectedCount: allergyCount,
    });
  };

  const handleScanFailed = (file) => {
    persistScan({
      text: '',
      source: 'photo',
      file: file || null,
      matches: [],
      selectedCount: allergyCount,
      failed: true,
    });
  };

  const matches = useMemo(() => {
    if (!result) return [];
    return findMatches(result.text, allergyState.selected, allergyState.custom);
  }, [result, allergyState]);

  const openDetail = (entry) => {
    setDetailEntry(entry);
    setScreen('detail');
  };

  return (
    <div className="app">
      <DeployNote />
      {screen === 'home' && (
        <HomeScreen
          selectedCount={allergyCount}
          onAddAllergies={() => setScreen('allergies')}
          onScan={() => setScreen('scan')}
          onHistory={() => setScreen('history')}
          onContact={() => setScreen('contact')}
        />
      )}
      {screen === 'allergies' && (
        <AllergiesScreen
          selected={allergyState.selected}
          custom={allergyState.custom}
          onToggle={toggle}
          onAddCustom={addCustom}
          onBack={() => setScreen(result ? 'result' : 'home')}
          onHome={goHome}
        />
      )}
      {screen === 'scan' && (
        <ScanScreen
          onResult={handleResult}
          onFailed={handleScanFailed}
          onBack={() => setScreen('home')}
          onHome={goHome}
        />
      )}
      {screen === 'result' && result && (
        <ResultScreen
          text={result.text}
          matches={matches}
          selectedCount={allergyCount}
          onScanAgain={() => setScreen('scan')}
          onEditAllergies={() => setScreen('allergies')}
          onHome={goHome}
        />
      )}
      {screen === 'history' && (
        <HistoryScreen
          selected={allergyState.selected}
          custom={allergyState.custom}
          onBack={() => setScreen('home')}
          onOpen={openDetail}
          onHome={goHome}
        />
      )}
      {screen === 'detail' && detailEntry && (
        <HistoryDetailScreen
          entry={detailEntry}
          selected={allergyState.selected}
          custom={allergyState.custom}
          onBack={() => setScreen('history')}
          onHome={goHome}
        />
      )}
      {screen === 'contact' && (
        <ContactScreen onBack={() => setScreen('home')} onHome={goHome} />
      )}
    </div>
  );
}
