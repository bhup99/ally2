import { useEffect, useMemo, useRef, useState } from 'react';
import { ALLERGENS } from './data/allergens.js';
import { findMatches, matchedLabels } from './lib/matcher.js';
import { saveScan, listScans, deleteScan, clearScans } from './lib/db.js';
import { downscaleImage } from './lib/image.js';

const STORAGE_KEY = 'allergy-scanner:v1';
const OCR_TIMEOUT_MS = 90000;

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

/* ------------------------------ small pieces ------------------------------ */

function Header({ title, onBack }) {
  return (
    <header className="topbar">
      {onBack && (
        <button className="iconbtn" onClick={onBack} aria-label="Back">
          ←
        </button>
      )}
      <h1>{title}</h1>
      <span className="spacer" />
      <span style={{ fontSize: 11, opacity: 0.45, fontWeight: 400 }}>v1.1</span>
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
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  if (!blob) return <div className="thumb placeholder" aria-hidden="true">📄</div>;
  if (!url) return <div className="thumb placeholder" aria-hidden="true" />;
  return <img className="thumb" src={url} alt="" />;
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

function HomeScreen({ selectedCount, onAddAllergies, onScan, onHistory }) {
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
    </div>
  );
}

function AllergiesScreen({ selected, custom, onToggle, onAddCustom, onBack }) {
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
      <Header title="Your allergies" onBack={onBack} />
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

function ScanScreen({ onResult, onFailed, onBack }) {
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState('idle'); // idle | reading | error
  const [errorKind, setErrorKind] = useState(null); // failed | empty
  const fileRef = useRef(null);

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
    }
  };

  return (
    <div className="screen">
      <Header title="Scan ingredients" onBack={onBack} />
      <div className="stack">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="filehidden"
          id="photo-input"
          onChange={(e) => handleFile(e.target.files && e.target.files[0])}
        />
        <label htmlFor="photo-input" className="bigbtn primary">
          📷 Take / upload label photo
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

function ResultScreen({ text, matches, selectedCount, onScanAgain, onEditAllergies }) {
  const labels = matchedLabels(matches);
  const hasAllergies = selectedCount > 0;

  return (
    <div className="screen">
      <Header title="Result" onBack={onScanAgain} />
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

function HistoryScreen({ onBack, onOpen }) {
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
      <Header title="Scan history" onBack={onBack} />
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
              const badge = VERDICT_BADGES[e.verdict] || VERDICT_BADGES.failed;
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

function HistoryDetailScreen({ entry, onBack }) {
  const [imgUrl, setImgUrl] = useState(null);

  useEffect(() => {
    if (!entry.image) return;
    const u = URL.createObjectURL(entry.image);
    setImgUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [entry]);

  return (
    <div className="screen">
      <Header title="Scan details" onBack={onBack} />
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
        verdict={entry.verdict}
        labels={entry.matchedAllergens || []}
        selectedCount={entry.selectedCount || 0}
      />
      {(entry.matchedAllergens || []).length > 0 && (
        <div className="matchchips">
          {entry.matchedAllergens.map((l) => (
            <span key={l} className="matchchip">⚠️ {l}</span>
          ))}
        </div>
      )}
      {imgUrl && <img className="detailimg" src={imgUrl} alt="Scanned label" />}
      {entry.extractedText ? (
        <>
          <h3 className="sectiontitle">Label text</h3>
          <div className="card">
            <HighlightedText text={entry.extractedText} matches={entry.matches || []} />
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
      selectedCount: allergyState.selected.length,
    });
  };

  const handleScanFailed = (file) => {
    persistScan({
      text: '',
      source: 'photo',
      file: file || null,
      matches: [],
      selectedCount: allergyState.selected.length,
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
      {screen === 'home' && (
        <HomeScreen
          selectedCount={allergyState.selected.length}
          onAddAllergies={() => setScreen('allergies')}
          onScan={() => setScreen('scan')}
          onHistory={() => setScreen('history')}
        />
      )}
      {screen === 'allergies' && (
        <AllergiesScreen
          selected={allergyState.selected}
          custom={allergyState.custom}
          onToggle={toggle}
          onAddCustom={addCustom}
          onBack={() => setScreen(result ? 'result' : 'home')}
        />
      )}
      {screen === 'scan' && (
        <ScanScreen
          onResult={handleResult}
          onFailed={handleScanFailed}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'result' && result && (
        <ResultScreen
          text={result.text}
          matches={matches}
          selectedCount={allergyState.selected.length}
          onScanAgain={() => setScreen('scan')}
          onEditAllergies={() => setScreen('allergies')}
        />
      )}
      {screen === 'history' && (
        <HistoryScreen onBack={() => setScreen('home')} onOpen={openDetail} />
      )}
      {screen === 'detail' && detailEntry && (
        <HistoryDetailScreen entry={detailEntry} onBack={() => setScreen('history')} />
      )}
    </div>
  );
}
