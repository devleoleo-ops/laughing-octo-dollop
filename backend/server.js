/**
 * Backend Proxy Server — WhatsApp Reaction Queue v3
 *
 * Anti-abuse (server-side, tidak bisa di-bypass dari frontend):
 *   1. Rate limit per fingerprint  — max DAILY_LIMIT request/hari (cek Firestore `cooldowns`)
 *   2. Rate limit per IP           — max IP_BURST_LIMIT request/menit (in-memory)
 *   3. Max queue size global       — tolak kalau antrian sudah penuh (MAX_QUEUE_SIZE)
 *   4. Duplicate URL check         — URL yang sama sudah ada di queue? tolak
 *   5. X-Proxy-Secret header auth  — wajib ada untuk POST /react
 *
 * Queue disimpan di Firebase Firestore (`react_queue`).
 * Semua config sensitif ada di .env.
 *
 * @author YogaXD
 */

'use strict';

require('dotenv').config();

const http  = require('http');
const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const path  = require('path');

// ============ CONFIG (dari .env) ============
const PORT         = process.env.PORT          || 3002;
const PROXY_SECRET = process.env.PROXY_SECRET  || '';
const _BASE        = process.env._API_BASE;
const _KEY         = process.env._API_KEY;
const SA_PATH      = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

// ─── Anti-abuse limits ───────────────────────────────────
const DAILY_LIMIT      = parseInt(process.env.DAILY_LIMIT      || '3',  10); // max 3x/hari per fp
const MAX_QUEUE_SIZE   = parseInt(process.env.MAX_QUEUE_SIZE   || '20', 10); // max 20 item di queue
const IP_BURST_LIMIT   = parseInt(process.env.IP_BURST_LIMIT   || '5',  10); // max 5 req/menit per IP
const IP_BURST_WINDOW  = 60 * 1000; // 1 menit
const QUEUE_DELAY      = parseInt(process.env.QUEUE_DELAY_MS   || '10000', 10); // jeda antar item

if (!_BASE || !_KEY) {
  console.error('[FATAL] _API_BASE / _API_KEY tidak ditemukan di .env');
  process.exit(1);
}

// ============ FIREBASE ADMIN INIT ============
const saPath = path.resolve(__dirname, SA_PATH);
const serviceAccount = require(saPath);

initializeApp({ credential: cert(serviceAccount) });

const db   = getFirestore();
const COLL = 'react_queue';   // antrian
const CD   = 'cooldowns';     // rate limit per fingerprint (shared dengan frontend)

// ============ STATE ============
let isProcessing = false;

// In-memory IP burst tracker: { ip: { count, windowStart } }
const ipTracker = new Map();

// ============ HELPERS ============

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ambil IP real dari request (support X-Forwarded-For) */
function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? xff.split(',')[0] : req.socket.remoteAddress || '').trim();
}

/** Midnight lokal hari ini dalam ms */
function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ============ ANTI-ABUSE CHECKS ============

/**
 * Cek & update rate limit per-IP (in-memory burst limiter).
 * Return true kalau allowed, false kalau kena limit.
 */
function checkIpBurst(ip) {
  const now  = Date.now();
  const rec  = ipTracker.get(ip);

  if (!rec || now - rec.windowStart > IP_BURST_WINDOW) {
    ipTracker.set(ip, { count: 1, windowStart: now });
    return true;
  }

  rec.count++;
  if (rec.count > IP_BURST_LIMIT) {
    return false;
  }
  return true;
}

/**
 * Cek rate limit per fingerprint dari Firestore `cooldowns`.
 * Pakai koleksi yang sama dengan frontend supaya sinkron.
 *
 * Return: { allowed: boolean, count: number, reason?: string }
 */
async function checkFpLimit(fp) {
  if (!fp || typeof fp !== 'string' || fp.length < 8) {
    return { allowed: false, reason: 'Fingerprint tidak valid' };
  }

  const snap = await db.collection(CD).doc(fp).get();

  if (!snap.exists) {
    // User baru, boleh
    return { allowed: true, count: 0 };
  }

  const data       = snap.data();
  const todayMs    = todayMidnightMs();
  const dayStartMs = data.dayStartAt instanceof Timestamp
    ? data.dayStartAt.toMillis()
    : (data.dayStartAt?.seconds ? data.dayStartAt.seconds * 1000 : 0);

  // Hari sudah berganti? reset
  if (dayStartMs < todayMs) {
    return { allowed: true, count: 0 };
  }

  const count = data.count ?? 0;
  if (count >= DAILY_LIMIT) {
    return { allowed: false, count, reason: `Limit ${DAILY_LIMIT}x/hari tercapai` };
  }

  return { allowed: true, count };
}

/**
 * Increment cooldown counter di Firestore.
 * Dipanggil SETELAH item berhasil masuk antrian (bukan setelah selesai diproses).
 */
async function incrementFpCount(fp, currentCount) {
  const todayMs    = todayMidnightMs();
  const dayStartTs = Timestamp.fromMillis(todayMs);
  const newCount   = currentCount + 1;

  await db.collection(CD).doc(fp).set({
    count      : newCount,
    dayStartAt : dayStartTs,
    updatedAt  : FieldValue.serverTimestamp(),
  }, { merge: true });

  return newCount;
}

/**
 * Cek apakah URL ini sudah ada di queue (pending/processing).
 * Mencegah submit URL yang sama berkali-kali.
 */
async function isDuplicateUrl(targetUrl) {
  const [pendSnap, procSnap] = await Promise.all([
    db.collection(COLL).where('status', '==', 'pending').where('target', '==', targetUrl).limit(1).get(),
    db.collection(COLL).where('status', '==', 'processing').where('target', '==', targetUrl).limit(1).get(),
  ]);
  return !pendSnap.empty || !procSnap.empty;
}

/**
 * Hitung total item aktif di queue (pending + processing).
 */
async function getActiveQueueCount() {
  const [pendSnap, procSnap] = await Promise.all([
    db.collection(COLL).where('status', '==', 'pending').count().get(),
    db.collection(COLL).where('status', '==', 'processing').count().get(),
  ]);
  return pendSnap.data().count + procSnap.data().count;
}

// ============ FIRESTORE QUEUE HELPERS ============

async function enqueue(targetUrl, reaction, fp, ip) {
  const doc = await db.collection(COLL).add({
    target    : targetUrl,
    reaction,
    status    : 'pending',
    fp        : fp || null,   // fingerprint (untuk audit trail)
    ip        : ip || null,   // IP (untuk audit trail, tidak diekspos ke client)
    createdAt : FieldValue.serverTimestamp(),
    updatedAt : FieldValue.serverTimestamp(),
  });
  return doc.id;
}

async function getPendingItems() {
  const snap = await db.collection(COLL)
    .where('status', '==', 'pending')
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.createdAt ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt ? b.createdAt.toMillis() : 0;
      return ta - tb;
    });
}

async function markProcessing(id) {
  await db.collection(COLL).doc(id).update({
    status    : 'processing',
    updatedAt : FieldValue.serverTimestamp(),
  });
}

async function markDone(id, success) {
  await db.collection(COLL).doc(id).update({
    status    : success ? 'done' : 'failed',
    updatedAt : FieldValue.serverTimestamp(),
  });
}

function waitForResult(id) {
  return new Promise((resolve) => {
    const unsub = db.collection(COLL).doc(id).onSnapshot((snap) => {
      const data = snap.data();
      if (data && (data.status === 'done' || data.status === 'failed')) {
        unsub();
        resolve({
          statusCode : 200,
          target     : data.target,
          reaction   : data.reaction,
          status     : data.status === 'done' ? 'success' : 'failed',
        });
      }
    });
  });
}

// ============ QUEUE WORKER ============

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  console.log('\n[Queue] Worker started');

  try {
    let items = await getPendingItems();

    while (items.length > 0) {
      const item = items[0];
      console.log('\n[Queue] Processing ' + item.id);
      console.log('   target   :', item.target);

      await markProcessing(item.id);

      let success = false;
      try {
        const r = await callReactionApi(item.target, item.reaction);
        console.log('   [API] HTTP ' + r.statusCode);
        success = r.statusCode === 200 && r.body && r.body.status === true;
      } catch (e) {
        console.log('   [API] Error:', e.message);
      }

      await markDone(item.id, success);
      console.log('   Result:', success ? 'done ✓' : 'failed ✗');

      items = await getPendingItems();
      if (items.length > 0) {
        console.log('[Queue] Waiting ' + (QUEUE_DELAY / 1000) + 's...');
        await sleep(QUEUE_DELAY);
      }
    }
  } catch (e) {
    console.error('[Queue] Worker error:', e.message);
  }

  isProcessing = false;
  console.log('[Queue] Worker done\n');
}

// ============ API CALLER ============

function callReactionApi(targetUrl, reaction) {
  return new Promise((resolve, reject) => {
    const params  = new URLSearchParams({ apikey: _KEY, url: targetUrl, reaction });
    const fullUrl = _BASE + '?' + params.toString();
    const parsed  = new URL(fullUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname : parsed.hostname,
      port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : 'GET',
      headers  : { 'User-Agent': 'ReactProxy/3.0', 'Accept': 'application/json' },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try   { resolve({ statusCode: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ statusCode: res.statusCode, body: {} }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ============ HTTP UTILS ============

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Secret, X-FP');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end',  () => {
      try   { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ── Validasi URL ──
const POST_URL_RE = /whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/\d+/;
function validateInput(targetUrl, reaction) {
  if (!targetUrl || typeof targetUrl !== 'string') return '"url" wajib diisi';
  if (!reaction  || typeof reaction  !== 'string') return '"reaction" wajib diisi';
  if (!POST_URL_RE.test(targetUrl))
    return 'URL harus menyertakan nomor post (contoh: /187)';
  return null;
}

// ── Auth ──
function checkSecret(req) {
  if (!PROXY_SECRET) return true;
  return req.headers['x-proxy-secret'] === PROXY_SECRET;
}

// ============ HTTP SERVER ============
const server = http.createServer(async (req, res) => {
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const ip = getIp(req);

  // ── GET /status ──────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/status') {
    const queueLength = await getActiveQueueCount();
    json(res, 200, { status: 'ok', isProcessing, queueLength, ts: Date.now() });
    return;
  }

  // ── GET /queue ───────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/queue') {
    const snap = await db.collection(COLL)
      .where('status', '==', 'pending')
      .limit(50)
      .get();

    const items = snap.docs
      .map((d) => ({
        id       : d.id,
        target   : d.data().target,
        reaction : d.data().reaction,
        status   : d.data().status,
        _ts      : d.data().createdAt ? d.data().createdAt.toMillis() : 0,
      }))
      .sort((a, b) => a._ts - b._ts)
      .map(({ _ts, ...rest }) => rest);

    json(res, 200, { isProcessing, queueLength: items.length, queue: items });
    return;
  }

  // ── POST /react ──────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/react') {

    // 1. Auth secret
    if (!checkSecret(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    // 2. IP burst limit
    if (!checkIpBurst(ip)) {
      console.log('[Abuse] IP burst limit:', ip);
      return json(res, 429, { error: 'Terlalu banyak request, coba lagi nanti.' });
    }

    // 3. Parse body
    let body;
    try { body = await readBody(req); }
    catch (_) { return json(res, 400, { error: 'Invalid JSON' }); }

    // 4. Validasi input
    const inputErr = validateInput(body.url, body.reaction);
    if (inputErr) return json(res, 400, { error: inputErr });

    // 5. Fingerprint rate limit (server-side, pakai Firestore cooldowns)
    const fp       = (req.headers['x-fp'] || '').trim();
    const fpCheck  = await checkFpLimit(fp);
    if (!fpCheck.allowed) {
      console.log('[Abuse] FP limit:', fp, '|', fpCheck.reason);
      return json(res, 429, { error: fpCheck.reason || 'Limit harian tercapai' });
    }

    // 6. Global queue size limit
    const queueCount = await getActiveQueueCount();
    if (queueCount >= MAX_QUEUE_SIZE) {
      console.log('[Abuse] Queue full:', queueCount, '>=', MAX_QUEUE_SIZE);
      return json(res, 503, { error: 'Antrian penuh, coba lagi nanti.' });
    }

    // 7. Duplicate URL check
    const isDup = await isDuplicateUrl(body.url);
    if (isDup) {
      return json(res, 409, { error: 'URL ini sudah ada di antrian.' });
    }

    // ── Semua check lolos, masukkan ke antrian ──
    const id = await enqueue(body.url, body.reaction, fp, ip);

    // Increment counter SETELAH berhasil masuk queue
    await incrementFpCount(fp, fpCheck.count);

    processQueue().catch((e) => console.error('[Queue] Crash:', e.message));

    const newQueueCount = queueCount + 1;
    console.log('\n[React] Queued', id, '| fp:', fp.substring(0, 8) + '...', '| pos:', newQueueCount);

    json(res, 202, {
      statusCode : 202,
      status     : 'queued',
      queueId    : id,
      position   : newQueueCount,
      message    : 'Request masuk antrian posisi #' + newQueueCount,
    });
    return;
  }

  // ── 404 ──────────────────────────────────────────────────
  json(res, 404, { error: 'Not found' });
});

// ── Resume pending saat boot ──
async function resumeOnBoot() {
  const items = await getPendingItems();
  if (items.length > 0) {
    console.log('[Boot] Resuming ' + items.length + ' pending item(s)...');
    processQueue().catch((e) => console.error('[Queue] Boot crash:', e.message));
  }
}

// ── Realtime listener: tangkap antrian baru dari Firestore (misal dari Vercel) ──
function listenToQueue() {
  console.log('[Queue] Realtime listener aktif (menunggu order dari Firestore)...');
  db.collection(COLL)
    .where('status', '==', 'pending')
    .onSnapshot((snapshot) => {
      if (!snapshot.empty && !isProcessing) {
        console.log(`[Queue] Ditemukan ${snapshot.size} item pending baru, memproses antrian...`);
        processQueue().catch((e) => console.error('[Queue] Worker error:', e.message));
      }
    }, (err) => {
      console.error('[Queue] Firestore listener error:', err.message);
    });
}

// ── Bersihkan ipTracker dari IP lama setiap 5 menit ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipTracker.entries()) {
    if (now - rec.windowStart > IP_BURST_WINDOW * 2) ipTracker.delete(ip);
  }
}, 5 * 60 * 1000);

server.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Reaction Queue Backend v3              ║');
  console.log('║   Port       : ' + PORT + '                      ║');
  console.log('║   Queue      : Firebase Firestore        ║');
  console.log('║   Delay      : ' + (QUEUE_DELAY / 1000) + 's per item          ║');
  console.log('║   Daily limit: ' + DAILY_LIMIT + 'x per fingerprint       ║');
  console.log('║   Queue max  : ' + MAX_QUEUE_SIZE + ' items                 ║');
  console.log('║   IP burst   : ' + IP_BURST_LIMIT + 'x per menit            ║');
  console.log('║   Auth       : ' + (PROXY_SECRET ? 'X-Proxy-Secret ✓' : 'OPEN (set PROXY_SECRET!)') + '        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  await resumeOnBoot();
  listenToQueue();
});
