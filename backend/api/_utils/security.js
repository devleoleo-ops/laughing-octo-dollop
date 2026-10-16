'use strict';

const crypto = require('crypto');
const https  = require('https');

// ============================================================
//  SECRETS — wajib di-set di Vercel Environment Variables
//  Jangan pernah hardcode nilai asli di sini!
// ============================================================
const CSRF_SECRET = process.env.CSRF_SECRET;
const IP_SALT     = process.env.IP_SALT;

if (!CSRF_SECRET || !IP_SALT) {
  // Gagal keras saat cold-start supaya ketahuan kalau env belum di-set
  throw new Error('[security] CSRF_SECRET dan IP_SALT wajib di-set di environment variables!');
}

// ============================================================
//  ALLOWED ORIGINS  (hardcoded + env override)
// ============================================================
const HARDCODED_ORIGINS = [
  'https://naomi-rch.zone.id',
  'https://rch-kazehaya.web.app',
  'https://rch-kazehaya.firebaseapp.com',
];

const envOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = envOrigins.length > 0
  ? [...new Set([...HARDCODED_ORIGINS, ...envOrigins])]
  : HARDCODED_ORIGINS;

// ============================================================
//  BOT USER-AGENTS BLOCKLIST
// ============================================================
const BOT_UA = [
  'python', 'curl', 'wget', 'httpie', 'postman', 'insomnia',
  'scrapy', 'selenium', 'phantomjs', 'headless', 'spider',
  'crawler', 'scraper', 'httpclient', 'java/', 'axios',
  'node-fetch', 'go-http-client', 'okhttp', 'apache-httpclient',
  'urllib', 'requests/', 'aiohttp', 'http.client', 'undici',
  'libwww-perl', 'pycurl', 'httprequest',
];

// ============================================================
//  IP HELPERS
// ============================================================

/**
 * Ambil IP real client.
 * Di Vercel, `x-real-ip` di-set oleh edge dan tidak bisa di-spoof client.
 */
function getClientIP(req) {
  return (
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Hash IP + salt supaya tidak menyimpan IP asli di Firestore.
 */
function hashIP(ip) {
  return 'h_' + crypto
    .createHash('sha256')
    .update(ip + IP_SALT)
    .digest('hex')
    .slice(0, 20);
}

// ============================================================
//  ORIGIN CHECK
// ============================================================

function checkOrigin(req) {
  const origin  = req.headers['origin']  || '';
  const referer = req.headers['referer'] || '';

  if (origin)  return ALLOWED_ORIGINS.some(o => origin === o);
  if (referer) return ALLOWED_ORIGINS.some(o => referer.startsWith(o));

  // Tanpa Origin dan Referer → pasti bukan browser
  return false;
}

function getCorsOrigin(req) {
  const origin = req.headers['origin'] || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

// ============================================================
//  BOT DETECTION
// ============================================================

function isBot(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();

  if (!ua || ua.length < 10)
    return { isBot: true, reason: 'missing_user_agent' };

  for (const b of BOT_UA) {
    if (ua.includes(b))
      return { isBot: true, reason: 'bot_ua:' + b };
  }

  return { isBot: false };
}

// ============================================================
//  BROWSER FINGERPRINT  (Sec-Fetch-* + Accept-Language)
//  Header ini bersifat "forbidden" — browser set otomatis,
//  tidak bisa dimodifikasi JS, dan server-side client tidak kirim.
// ============================================================

function validateBrowserFingerprint(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (!secFetchSite)
    return { valid: false, reason: 'missing_sec_fetch_site' };

  // same-origin = request dari domain kita sendiri
  // cross-site  = request dari domain lain (bot/scraper)
  if (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site')
    return { valid: false, reason: 'sec_fetch_site:' + secFetchSite };

  const secFetchMode = req.headers['sec-fetch-mode'];
  if (!secFetchMode)
    return { valid: false, reason: 'missing_sec_fetch_mode' };

  if (!req.headers['accept-language'])
    return { valid: false, reason: 'missing_accept_language' };

  return { valid: true };
}

// ============================================================
//  CSRF TOKEN  (HMAC-SHA256, IP-bound + JS Challenge)
//
//  Flow:
//    1. Client GET /api/get-token  → { token, challenge }
//    2. Client eval(challenge) di browser → dapat angka
//    3. Client POST /api/submit-react dengan header:
//         X-CSRF-Token: <token>
//         X-Challenge-Answer: <angka dari eval>
//    4. Server verify: HMAC cocok & IP sama
// ============================================================

function generateCsrfToken(ipHash) {
  // Math challenge — DOM-bound, gagal di Node.js karena cek typeof window
  const n1  = Math.floor(Math.random() * 97) + 3;
  const n2  = Math.floor(Math.random() * 97) + 3;
  const ops = ['+', '-', '*'];
  const op  = ops[Math.floor(Math.random() * ops.length)];

  let baseAnswer;
  if (op === '+') baseAnswer = n1 + n2;
  else if (op === '-') baseAnswer = n1 - n2;
  else baseAnswer = n1 * n2;

  const answer = String(baseAnswer);

  // Challenge hanya bisa di-solve di browser (butuh window & document)
  const challenge = `(function(){try{if(typeof window==='undefined'||typeof document==='undefined'||typeof navigator==='undefined'){throw new Error('no-dom');}var a=${n1},b=${n2},c=a${op}b;return String(c);}catch(e){return 'bot';}})()`;

  const nonce     = crypto.randomBytes(18).toString('base64url');
  const timestamp = Date.now().toString(36); // base36 supaya lebih pendek
  const ipPart    = ipHash || 'noip';

  // Data yang di-sign: nonce + ts + ip + answer
  const dataToSign = `${nonce}\x00${timestamp}\x00${ipPart}\x00${answer}`;
  const sig = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(dataToSign)
    .digest('base64url');

  // Token format: nonce.ts.ip.sig  (4 parts, split by ".")
  const token = `${nonce}.${timestamp}.${ipPart}.${sig}`;

  return { token, challenge };
}

function verifyCsrfToken(token, ipHash, clientAnswer) {
  if (!token || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 4) return false;

  const [nonce, timestamp, tokenIpHash, sig] = parts;

  // Cek expire: token valid 10 menit
  const tsMs    = parseInt(timestamp, 36);
  const tokenAge = Date.now() - tsMs;
  if (isNaN(tokenAge) || tokenAge > 10 * 60 * 1000 || tokenAge < 0) return false;

  // Cek IP binding
  if (ipHash && tokenIpHash !== ipHash) return false;

  // Cek jawaban challenge ada
  if (!clientAnswer || typeof clientAnswer !== 'string') return false;

  // Verify HMAC dengan jawaban yang dikirim client
  const dataToSign = `${nonce}\x00${timestamp}\x00${tokenIpHash}\x00${clientAnswer}`;
  const expectedSig = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(dataToSign)
    .digest('base64url');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig,         'base64url'),
      Buffer.from(expectedSig, 'base64url'),
    );
  } catch {
    return false;
  }
}

// ============================================================
//  CORS HELPER
// ============================================================

function applyCors(req, res, methods = 'POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin',  getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-CSRF-Token, X-Challenge-Answer, X-Requested-With, X-FP');
  res.setHeader('Vary', 'Origin');
}

// ============================================================
//  FULL SECURITY CHECK  (untuk submit endpoints)
//  Returns: null jika OK, object { status, error, code } jika blocked
// ============================================================

const BLOCKED_MSG = 'Akses ditolak. Gunakan web resmi.';

function securityCheck(req) {
  // 1. Bot UA
  const botResult = isBot(req);
  if (botResult.isBot)
    return { status: 403, error: BLOCKED_MSG, code: 'BOT_DETECTED' };

  // 2. Origin / Referer
  if (!checkOrigin(req))
    return { status: 403, error: BLOCKED_MSG, code: 'INVALID_ORIGIN' };

  // 3. Browser fingerprint (Sec-Fetch-*, Accept-Language)
  const bfp = validateBrowserFingerprint(req);
  if (!bfp.valid)
    return { status: 403, error: BLOCKED_MSG, code: 'INVALID_BROWSER' };

  // 4. CSRF token + challenge answer
  const csrfToken    = req.headers['x-csrf-token']       || req.body?._csrf;
  const clientAnswer = req.headers['x-challenge-answer'] || req.body?._challenge;
  const clientIP     = getClientIP(req);
  const ipHash       = hashIP(clientIP);

  if (!verifyCsrfToken(csrfToken, ipHash, clientAnswer))
    return { status: 403, error: BLOCKED_MSG, code: 'INVALID_CSRF' };

  // 5. X-Requested-With (browsers set this; curl/Postman jarang)
  if (!req.headers['x-requested-with'])
    return { status: 403, error: BLOCKED_MSG, code: 'MISSING_XHR' };

  return null; // semua OK
}


// ============================================================
//  RECAPTCHA VERIFIKASI
// ============================================================
/**
 * Verifikasi reCAPTCHA v2 token ke Google siteverify.
 * @param {string} token   — token dari grecaptcha.getResponse()
 * @param {string} [remoteip] — IP client (opsional tapi dianjurkan)
 * @returns {Promise<boolean>}
 */
function verifyRecaptcha(token, remoteip) {
  return new Promise((resolve) => {
    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret || !token) return resolve(false);

    const body = new URLSearchParams({ secret, response: token });
    if (remoteip) body.append('remoteip', remoteip);
    const bodyStr = body.toString();

    const opts = {
      hostname: 'www.google.com',
      path    : '/recaptcha/api/siteverify',
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data.success === true);
        } catch {
          resolve(false);
        }
      });
    });

    req.on('error', () => resolve(false));
    req.write(bodyStr);
    req.end();
  });
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
  getClientIP,
  hashIP,
  checkOrigin,
  getCorsOrigin,
  applyCors,
  isBot,
  validateBrowserFingerprint,
  generateCsrfToken,
  verifyCsrfToken,
  securityCheck,
  verifyRecaptcha,
  ALLOWED_ORIGINS,
};
