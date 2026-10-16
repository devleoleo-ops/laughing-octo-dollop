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
  apiKey: 'AIzaSyDG4J3cieRfrKg-mabgLkfBwliq3PJG7mI',
  authDomain: 'rch-kazehaya.firebaseapp.com',
  projectId: 'rch-kazehaya',
  storageBucket: 'rch-kazehaya.firebasestorage.app',
  messagingSenderId: '268393224025',
  appId: '1:268393224025:web:91709164f64c1a52635e48',
  measurementId: 'G-2368HKTFMH',
};

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

/* ── Constants ──────────────────────────────────────────────── */
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');
const FREE_LIMIT = 3;
const MAX_EMOJI = 12;
const DAY_MS = 86_400_000; // 24 jam

/* Midnight 00:00 WIB (UTC+7) dalam ms — fixed, tidak tergantung timezone device */
const WIB_OFFSET = 7 * 60 * 60 * 1000; // 7 jam dalam ms
function todayMidnightMs() {
  // Floor ke hari WIB → kalikan DAY_MS → kurangi offset = UTC timestamp dari 00:00 WIB
  return Math.floor((Date.now() + WIB_OFFSET) / DAY_MS) * DAY_MS - WIB_OFFSET;
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

/* ── Emoji-only filter: hapus teks biasa, hanya emoji + koma ── */
const EMOJI_RE = /\p{Extended_Pictographic}/u;
function filterEmojiOnly(raw) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const result = [...seg.segment(raw)]
    .map(({ segment }) => segment)
    .filter(s => s === ',' || s === ' ' || EMOJI_RE.test(s))
    .join('');

  // Hitung jumlah emoji yang sudah ada, batasi MAX_EMOJI
  const emojis = parseEmojis(result);
  if (emojis.length > MAX_EMOJI) {
    // Potong sampai MAX_EMOJI
    return emojis.slice(0, MAX_EMOJI).join('');
  }
  return result;
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
  const [emojiRaw, setEmojiRaw] = useState('');

  /* ── Parsed values ── */
  const [parsedEmojis, setParsedEmojis] = useState([]);
  const [parsedChatId, setParsedChatId] = useState(null);
  const [parsedChannel, setParsedChannel] = useState(null);
  const [emojiError, setEmojiError] = useState('');
  const [urlError, setUrlError] = useState('');

  /* ── Cooldown state ── */
  const [useCount, setUseCount] = useState(0);
  const [cooldownEnd, setCooldownEnd] = useState(null);
  const [cdRemaining, setCdRemaining] = useState(0);
  const [cdLoaded, setCdLoaded] = useState(false);

  /* ── Submit state ── */
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const logBoxRef = useRef(null);
  const submittingRef = useRef(false);
  const recaptchaRef = useRef(null);   // DOM node untuk widget
  const recaptchaWidgetId = useRef(null);  // ID dari grecaptcha.render()
  const [recaptchaToken, setRecaptchaToken] = useState('');
  const recaptchaTokenRef = useRef('');
  const fp = getFingerprint();

  /* ── Render reCAPTCHA widget saat script siap ── */
  useEffect(() => {
    const SITE_KEY = '6LfId-4tAAAAACdZMKpuQgJ62CwEE3dK9AzUSShu';

    const renderWidget = () => {
      if (!recaptchaRef.current || recaptchaWidgetId.current !== null) return;
      if (!window.grecaptcha || !window.grecaptcha.render) return;
      try {
        recaptchaWidgetId.current = window.grecaptcha.render(recaptchaRef.current, {
          sitekey: SITE_KEY,
          callback: (token) => {
            recaptchaTokenRef.current = token;
            setRecaptchaToken(token);
          },
          'expired-callback': () => {
            recaptchaTokenRef.current = '';
            setRecaptchaToken('');
          },
          'error-callback': () => {
            recaptchaTokenRef.current = '';
            setRecaptchaToken('');
          },
          theme: 'light',
          size: 'normal',
        });
      } catch (err) {
        console.warn('reCAPTCHA render error:', err);
      }
    };

    if (window.grecaptcha && window.grecaptcha.render) {
      renderWidget();
    } else {
      window.onRecaptchaReady = renderWidget;
    }
  }, []);

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
        writeCooldownDoc(fp, 0, Timestamp.fromMillis(todayMidnightMs())).catch(() => { });
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
    if (submittingRef.current) return;
    if (!channelLink.trim()) { setUrlError('Masukkan link channel terlebih dahulu.'); return; }
    if (!parsedChannel) { setUrlError('URL tidak valid.'); return; }
    if (parsedEmojis.length === 0) { setEmojiError('Masukkan emoji terlebih dahulu.'); return; }
    if (parsedEmojis.length > MAX_EMOJI) { setEmojiError(`Maksimal ${MAX_EMOJI} emoji.`); return; }
    // Ambil token dari ref, state, atau langsung dari grecaptcha API
    const activeCaptchaToken = recaptchaTokenRef.current || recaptchaToken || (
      typeof window !== 'undefined' && window.grecaptcha
        ? (recaptchaWidgetId.current !== null
            ? window.grecaptcha.getResponse(recaptchaWidgetId.current)
            : window.grecaptcha.getResponse())
        : ''
    );

    if (!activeCaptchaToken) {
      addLog('warn', 'Selesaikan verifikasi “I’m not a robot” terlebih dahulu.');
      return;
    }
    if (useCount >= FREE_LIMIT && cooldownEnd && cooldownEnd > Date.now()) {
      addLog('warn', `Limit ${FREE_LIMIT}x/hari tercapai. Reset dalam ${formatCountdown(cooldownEnd - Date.now())}.`);
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    setResult(null);
    addLog('info', `Target: ${channelLink.trim()}`);
    addLog('info', `Emoji: ${formatEmojis(parsedEmojis)}`);

    try {
      /* ── Step 1: Ambil CSRF token + JS challenge ── */
      addLog('info', 'Mengambil token keamanan…');
      const tokenRes = await fetch(`${BACKEND_URL}/api/get-token`, {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });

      if (!tokenRes.ok) {
        const e = await tokenRes.json().catch(() => ({}));
        throw new Error(e?.error || `Token gagal (${tokenRes.status})`);
      }

      const { token, challenge } = await tokenRes.json();
      if (!token) throw new Error('Token tidak valid, coba lagi.');

      /* ── Step 2: Solve JS challenge (harus jalan di browser) ── */
      let answer;
      try {
        // eslint-disable-next-line no-eval
        answer = String((0, eval)(challenge));
      } catch {
        throw new Error('Challenge gagal, coba lagi.');
      }

      /* ── Step 3: Submit reaction ke queue ── */
      const t0 = Date.now();
      const res = await fetch(`${BACKEND_URL}/api/submit-react`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'X-Challenge-Answer': answer,
          'X-Requested-With': 'XMLHttpRequest',
          'X-FP': fp,
        },
        body: JSON.stringify({
          url: channelLink.trim(),
          reaction: formatEmojis(parsedEmojis),
          fingerprint: fp,
          recaptcha: activeCaptchaToken,
        }),
      });

      const data = await res.json();
      const latency = Date.now() - t0;

      if (res.ok) {
        addLog('success', `Masuk antrian posisi #${data.position ?? '?'} (${latency}ms)`);
        setResult({ ok: true, data });

        /* Update counter lokal — server sudah nulis Firestore via Admin SDK */
        const newCount = useCount + 1;
        const todayMs = todayMidnightMs();
        setUseCount(newCount);

        if (newCount >= FREE_LIMIT) {
          setCooldownEnd(todayMs + DAY_MS);
          addLog('warn', `Batas ${FREE_LIMIT}x/hari tercapai. Reset besok tengah malam.`);
        }

        // Reset reCAPTCHA setelah submit sukses
        recaptchaTokenRef.current = '';
        setRecaptchaToken('');
        if (typeof window !== 'undefined' && window.grecaptcha) {
          if (recaptchaWidgetId.current !== null) {
            window.grecaptcha.reset(recaptchaWidgetId.current);
          } else {
            window.grecaptcha.reset();
          }
        }
      } else {
        const msg = res.status === 429
          ? (data?.error || 'Limit harian tercapai.')
          : res.status === 409
            ? 'URL ini sudah ada di antrian.'
            : res.status === 503
              ? 'Antrian penuh, coba lagi nanti.'
              : (data?.error || 'Pengiriman gagal, coba lagi.');
        addLog('error', msg);
        setResult({ ok: false, data });
      }

    } catch (err) {
      const msg = /limit|429|rate/i.test(err.message)
        ? 'Limit harian tercapai.'
        : (err.message || 'Pengiriman gagal, coba lagi.');
      addLog('error', msg);
      setResult({ ok: false, data: {} });
      // Reset reCAPTCHA juga kalau error
      recaptchaTokenRef.current = '';
      setRecaptchaToken('');
      if (typeof window !== 'undefined' && window.grecaptcha) {
        if (recaptchaWidgetId.current !== null) {
          window.grecaptcha.reset(recaptchaWidgetId.current);
        } else {
          window.grecaptcha.reset();
        }
      }
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }, [channelLink, parsedChannel, parsedEmojis, useCount, cooldownEnd, addLog, fp, recaptchaToken]);

  /* ── Derived ── */
  const isOnCooldown = useCount >= FREE_LIMIT && !!cooldownEnd && cooldownEnd > Date.now();
  const freeLeft = Math.max(0, FREE_LIMIT - useCount);
  const canSubmit = !!parsedChannel && parsedEmojis.length > 0 && !loading && !isOnCooldown && cdLoaded && !!recaptchaToken;

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
        <span className="sticker s7">💫</span>
      </div>

      <main className="app-wrapper">

        {/* ── Header ── */}
        <header className="header">
          {/* <div className="eyebrow-badge">
            <span className="pulse-dot" />
            WA REACTOR
          </div> */}
          <h1 className="header-title">
            WHATSAPP<br />
            <span className="title-accent">REACTION</span><br />
            TOOL
          </h1>
          <p className="header-sub">
            Kirim reaksi emoji ke channel WhatsApp favoritmu —
            gratis, cepat, dan aman.
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


          {/* ── Join Channel Banner ── */}
          <a
            href="https://whatsapp.com/channel/0029VbE3IzH6mYPM1fviqn3c"
            target="_blank"
            rel="noopener noreferrer"
            className="join-banner"
          >
            <span className="join-banner-icon">📣</span>
            <span className="join-banner-text">
              Join saluran untuk info selanjutnya,{' '}
              <span className="join-banner-link">klik disini</span>
            </span>
          </a>

          {/* ── Cooldown status — di atas form ── */}
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

          <div className="field-divider" />

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
                <span className="count-tag">{parsedEmojis.length}/{MAX_EMOJI} EMOJI</span>
              )}
            </div>
            <textarea
              id="emoji-input"
              className="emoji-textarea"
              value={emojiRaw}
              onChange={e => setEmojiRaw(filterEmojiOnly(e.target.value))}
              placeholder="Paste emoji di sini… (emoji only 🔥😭✨)"
              rows={3}
              spellCheck="false"
            />
            {emojiError && <p className="field-error">{emojiError}</p>}
          </div>

          <div className="field-divider" />

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

          {/* ── reCAPTCHA widget ── */}
          <div className="recaptcha-wrap">
            <div ref={recaptchaRef} />
          </div>

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
                <p>{result.ok
                  ? 'Request sudah masuk antrian dan sedang diproses.'
                  : (result.data?.error || 'Terjadi kesalahan, coba lagi.')
                }</p>
              </div>
            </div>
          )}

        </div>{/* end .main-card */}

      </main>
    </>
  );
}
