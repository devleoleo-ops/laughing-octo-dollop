import { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

/* ── Firebase init ──────────────────────────────────────────── */
const firebaseConfig = {
  apiKey           : 'AIzaSyDG4J3cieRfrKg-mabgLkfBwliq3PJG7mI',
  authDomain       : 'rch-kazehaya.firebaseapp.com',
  projectId        : 'rch-kazehaya',
  storageBucket    : 'rch-kazehaya.firebasestorage.app',
  messagingSenderId: '268393224025',
  appId            : '1:268393224025:web:91709164f64c1a52635e48',
  measurementId    : 'G-2368HKTFMH',
};

const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);

/* ── Constants ──────────────────────────────────────────────── */
const API_BASE   = 'https://api-v1-kenz.edgeone.dev/api/v1';
const API_KEY    = 'anzz_live_681308badc1bfce486024c2878d0e711014fde7626bbba50';
const FREE_LIMIT = 3;
const DAY_MS     = 86_400_000; // 24 jam

/* Midnight awal hari ini (local time) dalam ms */
function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* Format sisa waktu → "HH:MM:SS" */
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

/* ── Utility: parse emoji string ───────────────────────────── */
function parseEmojis(raw) {
  if (!raw.trim()) return [];
  if (raw.includes(',')) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...seg.segment(raw)]
    .map(s => s.segment.trim())
    .filter(Boolean);
}

function formatEmojis(emojis) {
  return emojis.join(',');
}

/* ── Utility: extract from WA channel URL ───────────────────── */
function parseChatId(url) {
  const m = url.match(/\/channel\/[^/]+\/(\d+)/);
  return m ? m[1] : null;
}

function parseChannelCode(url) {
  const m = url.match(/\/channel\/([^/]+)/);
  return m ? m[1] : null;
}

/* ── Anonymous fingerprint ──────────────────────────────────── */
function getFingerprint() {
  let fp = localStorage.getItem('wares_fp');
  if (!fp) {
    fp = crypto.randomUUID();
    localStorage.setItem('wares_fp', fp);
  }
  return fp;
}

/* ── Firebase cooldown helpers ──────────────────────────────── */
async function getCooldownDoc(fp) {
  const snap = await getDoc(doc(db, 'cooldowns', fp));
  return snap.exists() ? snap.data() : null;
}

/**
 * Simpan doc cooldown.
 * @param {string}    fp         - fingerprint
 * @param {number}    count      - jumlah pemakaian hari ini
 * @param {Timestamp} dayStartTs - Timestamp awal hari (midnight)
 */
async function writeCooldownDoc(fp, count, dayStartTs) {
  await setDoc(
    doc(db, 'cooldowns', fp),
    { count, dayStartAt: dayStartTs, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

/* ── LogItem ────────────────────────────────────────────────── */
function LogItem({ type, text, time }) {
  const icons = { info: 'ℹ', success: '✓', error: '✕', warn: '⚠' };
  return (
    <div className="log-item">
      <span className={`log-icon ${type}`}>{icons[type] ?? 'ℹ'}</span>
      <span className="log-text">
        {text}{' '}
        <span className="log-time">{time}</span>
      </span>
    </div>
  );
}

/* ── Ruler bar (design-tool decoration) ─────────────────────── */
function RulerBar() {
  const marks = Array.from({ length: 20 }, (_, i) => i);
  return (
    <div className="ruler-bar" aria-hidden="true">
      {marks.map(i => (
        <div key={i} className={`ruler-mark${i % 5 === 0 ? ' major' : ''}`}>
          {i % 5 === 0 && (
            <span className="ruler-num" style={{ left: `${(i / 20) * 100}%` }}>
              {i * 30}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════════════════════ */
export default function App() {
  /* ── Input state ── */
  const [channelLink, setChannelLink] = useState('');
  const [emojiRaw,    setEmojiRaw]    = useState('');

  /* ── Parsed values ── */
  const [parsedEmojis,  setParsedEmojis]  = useState([]);
  const [parsedChatId,  setParsedChatId]  = useState(null);
  const [parsedChannel, setParsedChannel] = useState(null);
  const [emojiError,    setEmojiError]    = useState('');
  const [urlError,      setUrlError]      = useState('');

  /* ── Cooldown state ── */
  const [useCount,    setUseCount]    = useState(0);
  const [cooldownEnd, setCooldownEnd] = useState(null);
  const [cdRemaining, setCdRemaining] = useState(0);
  const [cdLoaded,    setCdLoaded]    = useState(false);

  /* ── Submit state ── */
  const [loading, setLoading] = useState(false);
  const [logs,    setLogs]    = useState([]);
  const [result,  setResult]  = useState(null);
  const logBoxRef    = useRef(null);
  const submittingRef = useRef(false); // synchronous double-submit guard
  const fp = getFingerprint();

  /* ── Load cooldown from Firebase ── */
  useEffect(() => {
    (async () => {
      try {
        const data = await getCooldownDoc(fp);
        if (data) {
          const dayStartMs = data.dayStartAt instanceof Timestamp
            ? data.dayStartAt.toMillis()
            : data.dayStartAt?.seconds
              ? data.dayStartAt.seconds * 1000
              : 0;
          const todayMs = todayMidnightMs();
          if (dayStartMs >= todayMs) {
            setUseCount(data.count ?? 0);
            if ((data.count ?? 0) >= FREE_LIMIT) {
              setCooldownEnd(todayMs + DAY_MS);
            }
          } else {
            setUseCount(0);
          }
        }
      } catch (e) {
        console.warn('Firebase read error:', e);
      }
      setCdLoaded(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Cooldown countdown ticker ── */
  useEffect(() => {
    if (!cooldownEnd) { setCdRemaining(0); return; }
    const tick = () => {
      const rem = cooldownEnd - Date.now();
      if (rem <= 0) {
        setCdRemaining(0);
        setCooldownEnd(null);
        setUseCount(0);
        writeCooldownDoc(fp, 0, Timestamp.fromMillis(todayMidnightMs())).catch(() => {});
      } else {
        setCdRemaining(rem);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownEnd, fp]);

  /* ── Parse emoji on input ── */
  useEffect(() => {
    setEmojiError('');
    if (!emojiRaw.trim()) { setParsedEmojis([]); return; }
    const emojis = parseEmojis(emojiRaw);
    if (emojis.length === 0) {
      setEmojiError('Tidak ada emoji valid yang terdeteksi.');
    }
    setParsedEmojis(emojis);
  }, [emojiRaw]);

  /* ── Parse channel URL on input ── */
  useEffect(() => {
    setUrlError('');
    if (!channelLink.trim()) { setParsedChatId(null); setParsedChannel(null); return; }
    const channel = parseChannelCode(channelLink);
    if (!channel) {
      setUrlError('URL tidak valid. Contoh: https://whatsapp.com/channel/XXXX/100');
      setParsedChatId(null);
      setParsedChannel(null);
    } else {
      setParsedChannel(channel);
      setParsedChatId(parseChatId(channelLink));
    }
  }, [channelLink]);

  /* ── Auto scroll logs ── */
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  /* ── Add log ── */
  const addLog = useCallback((type, text) => {
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev, { type, text, time, id: Date.now() + Math.random() }]);
  }, []);

  /* ── Submit ── */
  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return; // blok double-fire sebelum state update
    if (!channelLink.trim()) { setUrlError('Masukkan link channel terlebih dahulu.'); return; }
    if (!parsedChannel)      { setUrlError('URL tidak valid.'); return; }
    if (parsedEmojis.length === 0) { setEmojiError('Masukkan emoji terlebih dahulu.'); return; }
    if (useCount >= FREE_LIMIT && cooldownEnd && cooldownEnd > Date.now()) {
      addLog('warn', `Limit ${FREE_LIMIT}x/hari tercapai. Reset dalam ${formatCountdown(cooldownEnd - Date.now())}.`);
      return;
    }

    submittingRef.current = true; // kunci segera (synchronous)
    setLoading(true);
    setResult(null);
    addLog('info', `Target: ${channelLink.trim()}`);
    addLog('info', `Emoji: ${formatEmojis(parsedEmojis)}`);

    try {
      /* ── Step 1: Handshake token ── */
      const hsRes = await fetch(`${API_BASE}/handshake`, {
        method : 'POST',
        headers: { 'X-API-Key': API_KEY },
      });

      if (!hsRes.ok) {
        const errData = await hsRes.json().catch(() => ({}));
        throw new Error(errData?.message ?? `Handshake failed (${hsRes.status})`);
      }

      const hs = await hsRes.json();
      if (!hs?.token) throw new Error('Handshake gagal, coba lagi.');

      /* ── Step 2: Kirim reaction ── */
      const t0  = Date.now();
      const res = await fetch(`${API_BASE}/react`, {
        method : 'POST',
        headers: {
          'Content-Type'      : 'application/json',
          'X-API-Key'         : API_KEY,
          'X-Handshake-Token' : hs.token,
        },
        body: JSON.stringify({
          url      : channelLink.trim(),
          reactions: parsedEmojis,
        }),
      });



      const data    = await res.json();
      const latency = Date.now() - t0;

      if (res.ok && data?.ok !== false) {
        addLog('success', `Berhasil dikirim! (${latency}ms)`);
        setResult({ ok: true, data });
      } else {
        const msg = res.status === 429 ? 'Server sedang overload, coba lagi sebentar.' : 'Pengiriman gagal, coba lagi.';
        addLog('error', msg);
        setResult({ ok: false, data });
      }

      /* ── Update daily cooldown ── */
      const newCount   = useCount + 1;
      const todayMs    = todayMidnightMs();
      const dayStartTs = Timestamp.fromMillis(todayMs);
      setUseCount(newCount);

      if (newCount >= FREE_LIMIT) {
        setCooldownEnd(todayMs + DAY_MS);
        addLog('warn', `Batas ${FREE_LIMIT}x/hari tercapai. Reset besok tengah malam.`);
      }
      await writeCooldownDoc(fp, newCount, dayStartTs);

    } catch (err) {
      const msg = /429|rate|overload/i.test(err.message)
        ? 'Server sedang overload, coba lagi sebentar.'
        : 'Pengiriman gagal, coba lagi.';
      addLog('error', msg);
      setResult({ ok: false, data: {} });
    } finally {
      submittingRef.current = false; // buka kunci
      setLoading(false);
    }
  }, [channelLink, parsedChannel, parsedChatId, parsedEmojis, useCount, cooldownEnd, addLog, fp]);

  /* ── Derived ── */
  const isOnCooldown = useCount >= FREE_LIMIT && !!cooldownEnd && cooldownEnd > Date.now();
  const freeLeft     = Math.max(0, FREE_LIMIT - useCount);
  const canSubmit    = !!parsedChannel && parsedEmojis.length > 0 && !loading && !isOnCooldown && cdLoaded;

  /* ════════════════════════════════════════════════════════════
     RENDER — Nudge-inspired neo-brutalist design
  ════════════════════════════════════════════════════════════ */
  return (
    <>
      {/* ── Floating emoji stickers ── */}
      <div className="app-stickers" aria-hidden="true">
        <span className="sticker s1">😊</span>
        <span className="sticker s2">❤️</span>
        <span className="sticker s3">🔥</span>
        <span className="sticker s4">✨</span>
        <span className="sticker s5">😂</span>
        <span className="sticker s6">😭</span>
      </div>

      <main className="app-wrapper">

        {/* ── Header ── */}
        <header className="header">
          <div className="eyebrow-badge">
            <span className="pulse-dot" />
            WA REACTOR
          </div>
          <h1 className="header-title">
            WHATSAPP<br />
            <span className="title-accent">REACTION</span><br />
            TOOL
          </h1>
          <p className="header-sub">
            Kirim reaksi emoji ke channel WhatsApp favoritmu dengan mudah dan cepat.
          </p>
        </header>

        {/* ── Design-tool ruler bar ── */}
        <RulerBar />

        {/* ── Main card ── */}
        <div className="main-card">

          {/* Framer-style corner + edge handles */}
          <span className="handle tl" />
          <span className="handle tr" />
          <span className="handle bl" />
          <span className="handle br" />
          <span className="handle mt" />
          <span className="handle mb" />
          <span className="handle ml" />
          <span className="handle mr" />

          {/* ── Link Channel ── */}
          <div className="field-group">
            <div className="field-label">
              <span>🔗</span>
              LINK CHANNEL
            </div>
            <div className="url-input-wrap">
              <span className="url-icon">🌐</span>
              <input
                id="channel-link-input"
                className="url-input"
                type="url"
                value={channelLink}
                onChange={e => setChannelLink(e.target.value)}
                placeholder="https://whatsapp.com/channel/XXXX/100"
                autoComplete="off"
                spellCheck="false"
              />
            </div>
            {urlError && <p className="field-error">{urlError}</p>}
            {parsedChannel && (
              <div className="parsed-row">
                <div className="parsed-chip">
                  <span className="chip-label">CHANNEL</span>
                  <span className="chip-value">{parsedChannel}</span>
                </div>
                {parsedChatId && (
                  <div className="parsed-chip accent">
                    <span className="chip-label">CHAT ID</span>
                    <span className="chip-value">{parsedChatId}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="field-divider" />

          {/* ── Emoji Reaksi ── */}
          <div className="field-group">
            <div className="field-label">
              <span>😊</span>
              EMOJI REAKSI
              {parsedEmojis.length > 0 && (
                <span className="count-tag">{parsedEmojis.length} EMOJI</span>
              )}
            </div>
            <textarea
              id="emoji-input"
              className="emoji-textarea"
              value={emojiRaw}
              onChange={e => setEmojiRaw(e.target.value)}
              placeholder="Ketik atau paste emoji di sini…"
              rows={3}
              spellCheck="false"
            />
            {emojiError && <p className="field-error">{emojiError}</p>}
          </div>

          <div className="field-divider" />

          {/* ── Cooldown status ── */}
          <div className="cooldown-row">
            <div className="cd-dots">
              {[...Array(FREE_LIMIT)].map((_, i) => (
                <span
                  key={i}
                  className={`cd-dot ${i < useCount ? (isOnCooldown ? 'used-cd' : 'used') : ''}`}
                />
              ))}
            </div>
            <span className="cd-label">
              {isOnCooldown
                ? 'Limit hari ini habis'
                : freeLeft > 0
                  ? `${freeLeft}× lagi hari ini`
                  : 'Siap kirim lagi!'}
            </span>
            <span className={`cd-badge${isOnCooldown ? ' on-cd' : ''}`}>
              {isOnCooldown ? '⏸ HABIS' : `${freeLeft}/${FREE_LIMIT} /HARI`}
            </span>
          </div>

          {isOnCooldown && (
            <div className="cd-bar-wrap">
              <div className="cd-bar-track">
                <div
                  className="cd-bar-fill"
                  style={{ width: `${Math.max(0, Math.min(100, (cdRemaining / DAY_MS) * 100))}%` }}
                />
              </div>
              <span className="cd-bar-label">⏳ {formatCountdown(cdRemaining)}</span>
            </div>
          )}

          {/* ── Submit button ── */}
          <button
            id="submit-btn"
            className={`submit-btn${loading ? ' loading' : ''}`}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {loading
              ? <><span className="spinner" /> MENGIRIM…</>
              : isOnCooldown
                ? <>⏸ TUNGGU RESET</>
                : <>KIRIM REAKSI →</>}
          </button>

          {/* ── Log aktivitas ── */}
          {logs.length > 0 && (
            <div className="log-section">
              <div className="field-label" style={{ marginBottom: '8px' }}>
                <span>📋</span>
                LOG AKTIVITAS
              </div>
              <div className="log-box" ref={logBoxRef}>
                {logs.map(l => (
                  <LogItem key={l.id} type={l.type} text={l.text} time={l.time} />
                ))}
              </div>
            </div>
          )}

          {/* ── Result ── */}
          {result && (
            <div className={`result-card${result.ok ? '' : ' error'}`}>
              <span className="result-icon">{result.ok ? '🎉' : '⚠️'}</span>
              <div>
                <strong>{result.ok ? 'Reaksi berhasil dikirim!' : 'Pengiriman gagal'}</strong>
                <p>{JSON.stringify(result.data)}</p>
              </div>
            </div>
          )}

        </div>{/* end .main-card */}

      </main>
    </>
  );
}
