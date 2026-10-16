/**
 * Backend Proxy Server — WhatsApp Reaction Queue v4 (Quota-Optimized)
 *
 * Perubahan dari v3:
 *   - Field status antrian menggunakan `isDone: boolean`:
 *       - isDone: false  → masih dalam antrian
 *       - isDone: true   → sudah dikerjakan (selesai)
 *   - Hapus state transient "processing" dari Firestore (disimpan di in-memory VPS)
 *     → Menghemat 50% Firestore Writes & mencegah cascading snapshot triggers!
 *   - Batch processing & in-memory sorting:
 *     → Mencegah query ulang berulang-ulang (O(N^2) reads dihilangkan)
 *   - In-memory cache untuk queue count (hemat count reads pada polling/health check)
 *   - Realtime listener hanya memantau `isDone == false`
 *   - Auto-cleanup dokumen `isDone: true` yang sudah berumur > 24 jam agar koleksi tetap bersih
 *
 * Anti-abuse:
 *   1. Rate limit per fingerprint  — max DAILY_LIMIT request/hari (Firestore `cooldowns`)
 *   2. Rate limit per IP           — max IP_BURST_LIMIT request/menit (in-memory)
 *   3. Max queue size global       — tolak jika antrian penuh (MAX_QUEUE_SIZE)
 *   4. Duplicate URL check         — tolak jika URL yang sama masih antre (isDone: false)
 *   5. X-Proxy-Secret header auth  — proteksi endpoint POST /react
 *
 * @author YogaXD
 */

const path  = require('path');
const fs    = require('fs');

// Load .env dari direktori backend atau root
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config();

const http  = require('http');
const https = require('https');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ============ CONFIG (dari .env) ============
const PORT         = parseInt(process.env.PORT || '3002', 10);
const PROXY_SECRET = process.env.PROXY_SECRET || '';
const _BASE        = process.env._API_BASE;
const _KEY         = process.env._API_KEY;
const SA_PATH      = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

// ─── Anti-abuse limits ───────────────────────────────────
const DAILY_LIMIT      = parseInt(process.env.DAILY_LIMIT    || '3',  10);
const MAX_QUEUE_SIZE   = parseInt(process.env.MAX_QUEUE_SIZE || '20', 10);
const IP_BURST_LIMIT   = parseInt(process.env.IP_BURST_LIMIT || '5',  10);
const IP_BURST_WINDOW  = 60 * 1000; // 1 menit
const QUEUE_DELAY      = parseInt(process.env.QUEUE_DELAY_MS || '10000', 10); // jeda antar item

if (!_BASE || !_KEY) {
  console.error('[FATAL] _API_BASE / _API_KEY tidak ditemukan di .env');
  process.exit(1);
}

// ============ FIREBASE ADMIN INIT ============
function initFirebase() {
  if (getApps().length > 0) return getFirestore();

  let credential = null;

  // 1. File path
  if (SA_PATH) {
    const resolvedPath = path.isAbsolute(SA_PATH)
      ? SA_PATH
      : path.resolve(__dirname, SA_PATH);

    if (fs.existsSync(resolvedPath)) {
      credential = cert(require(resolvedPath));
    }
  }

  // 2. JSON string di env
  if (!credential && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      try {
        credential = cert(JSON.parse(raw));
      } catch {
        raw = raw.replace(/\\\\n/g, '\\n');
        credential = cert(JSON.parse(raw));
      }
    } catch (e) {
      console.warn('[Firebase] Gagal parse FIREBASE_SERVICE_ACCOUNT JSON:', e.message);
    }
  }

  // 3. Variable terpisah
  if (!credential && process.env.FIREBASE_PROJECT_ID) {
    credential = cert({
      projectId   : process.env.FIREBASE_PROJECT_ID,
      clientEmail : process.env.FIREBASE_CLIENT_EMAIL,
      privateKey  : (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }

  if (!credential) {
    console.error('[FATAL] Firebase credentials tidak ditemukan! Periksa FIREBASE_SERVICE_ACCOUNT_PATH atau FIREBASE_SERVICE_ACCOUNT di .env');
    process.exit(1);
  }

  initializeApp({ credential });
  return getFirestore();
}

const db   = initFirebase();
const COLL = 'react_queue';   // antrian utama
const CD   = 'cooldowns';     // rate limit per fingerprint

// ============ IN-MEMORY STATE ============
let isProcessing = false;
const inFlightSet = new Set(); // ID item yang sedang diproses di memory

// In-memory IP burst tracker: { ip: { count, windowStart } }
const ipTracker = new Map();

// In-memory queue count cache (hemat Firestore count reads pada polling)
let cachedQueueCount = 0;
let lastCountFetchTime = 0;
const COUNT_CACHE_TTL = 5000; // 5 detik

// ============ HELPERS ============

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? xff.split(',')[0] : req.socket.remoteAddress || '').trim();
}

// Midnight 00:00 WIB (UTC+7) dalam ms
const WIB_OFFSET = 7 * 60 * 60 * 1000;
const DAY_MS     = 86_400_000;
function todayMidnightMs() {
  return Math.floor((Date.now() + WIB_OFFSET) / DAY_MS) * DAY_MS - WIB_OFFSET;
}

// ============ ANTI-ABUSE CHECKS ============

function checkIpBurst(ip) {
  const now  = Date.now();
  const rec  = ipTracker.get(ip);

  if (!rec || now - rec.windowStart > IP_BURST_WINDOW) {
    ipTracker.set(ip, { count: 1, windowStart: now });
    return true;
  }

  rec.count++;
  return rec.count <= IP_BURST_LIMIT;
}

async function checkFpLimit(fp) {
  if (!fp || typeof fp !== 'string' || fp.length < 8) {
    return { allowed: false, reason: 'Fingerprint tidak valid' };
  }

  const snap = await db.collection(CD).doc(fp).get();
  if (!snap.exists) {
    return { allowed: true, count: 0 };
  }

  const data       = snap.data();
  const todayMs    = todayMidnightMs();
  const dayStartMs = data.dayStartAt instanceof Timestamp
    ? data.dayStartAt.toMillis()
    : (data.dayStartAt?.seconds ? data.dayStartAt.seconds * 1000 : 0);

  if (dayStartMs < todayMs) {
    return { allowed: true, count: 0 };
  }

  const count = data.count ?? 0;
  if (count >= DAILY_LIMIT) {
    return { allowed: false, count, reason: `Limit ${DAILY_LIMIT}x/hari tercapai` };
  }

  return { allowed: true, count };
}

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
 * Cek apakah URL ini masih antre belum selesai (isDone == false).
 */
async function isDuplicateUrl(targetUrl) {
  const snap = await db.collection(COLL)
    .where('target', '==', targetUrl)
    .where('isDone', '==', false)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Hitung jumlah item aktif di antrian (isDone == false) dengan in-memory cache.
 */
async function getActiveQueueCount(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && (now - lastCountFetchTime < COUNT_CACHE_TTL)) {
    return cachedQueueCount;
  }

  const snap = await db.collection(COLL)
    .where('isDone', '==', false)
    .count()
    .get();

  cachedQueueCount = snap.data().count;
  lastCountFetchTime = now;
  return cachedQueueCount;
}

// ============ FIRESTORE QUEUE HELPERS ============

async function enqueue(targetUrl, reaction, fp, ip) {
  const doc = await db.collection(COLL).add({
    target    : targetUrl,
    reaction  : reaction.trim(),
    isDone    : false,        // false = antrian, true = sudah dikerjakan
    fp        : fp || null,   // audit
    ip        : ip || null,   // audit
    createdAt : FieldValue.serverTimestamp(),
    updatedAt : FieldValue.serverTimestamp(),
  });
  cachedQueueCount++;
  return doc.id;
}

/**
 * Ambil batch item yang masih antre (isDone == false).
 * Menggunakan sorting in-memory agar tidak memerlukan composite index berbayar di Firestore.
 */
async function getPendingBatch(limitCount = 20) {
  const snap = await db.collection(COLL)
    .where('isDone', '==', false)
    .limit(limitCount)
    .get();

  if (snap.empty) return [];

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0);
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0);
      return ta - tb;
    });
}

/**
 * Update status selesai pada dokumen Firestore (hanya 1x write per item).
 */
async function markItemDone(id, success, apiResult) {
  await db.collection(COLL).doc(id).update({
    isDone    : true,
    success   : success,
    status    : success ? 'done' : 'failed', // backward compatibility
    result    : apiResult || null,
    doneAt    : FieldValue.serverTimestamp(),
    updatedAt : FieldValue.serverTimestamp(),
  });
  if (cachedQueueCount > 0) cachedQueueCount--;
}

// ============ QUEUE WORKER (QUOTA-EFFICIENT) ============

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  console.log('\n[Queue] Worker aktif...');

  try {
    let hasMore = true;

    while (hasMore) {
      const batch = await getPendingBatch(15);
      // Filter out item yang mungkin sedang diproses
      const todo = batch.filter(item => !inFlightSet.has(item.id));

      if (todo.length === 0) {
        hasMore = false;
        break;
      }

      for (let i = 0; i < todo.length; i++) {
        const item = todo[i];
        inFlightSet.add(item.id);

        console.log(`\n[Queue] Mengerjakan [${item.id}]`);
        console.log(`   Target   : ${item.target}`);
        console.log(`   Reaction : ${item.reaction}`);

        let success = false;
        let bodyResult = null;

        try {
          const r = await callReactionApi(item.target, item.reaction);
          console.log(`   [API] HTTP ${r.statusCode}`);
          bodyResult = r.body;
          success = r.statusCode === 200 && r.body && r.body.status === true;
        } catch (e) {
          console.error(`   [API] Error: ${e.message}`);
          bodyResult = { error: e.message };
        }

        // Tulis hasil ke Firestore (1x write, isDone = true)
        await markItemDone(item.id, success, bodyResult);
        inFlightSet.delete(item.id);

        console.log(`   Hasil: ${success ? 'SUKSES ✓ (isDone: true)' : 'GAGAL ✗ (isDone: true)'}`);

        // Berikan jeda antar request jika masih ada antrian
        const isLastInBatch = (i === todo.length - 1);
        if (!isLastInBatch || todo.length >= 15) {
          console.log(`   [Queue] Delay ${QUEUE_DELAY / 1000}s...`);
          await sleep(QUEUE_DELAY);
        }
      }
    }
  } catch (e) {
    console.error('[Queue] Worker error:', e.message);
  } finally {
    isProcessing = false;
    console.log('[Queue] Worker selesai (idle)\n');
  }
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
      headers  : { 'User-Agent': 'ReactProxy/4.0', 'Accept': 'application/json' },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try   { resolve({ statusCode: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ statusCode: res.statusCode, body: { raw } }); }
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

const POST_URL_RE = /whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/\d+/;
function validateInput(targetUrl, reaction) {
  if (!targetUrl || typeof targetUrl !== 'string') return '"url" wajib diisi';
  if (!reaction  || typeof reaction  !== 'string') return '"reaction" wajib diisi';
  if (!POST_URL_RE.test(targetUrl))
    return 'URL harus menyertakan nomor post (contoh: /187)';
  return null;
}

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
    json(res, 200, {
      status: 'ok',
      isProcessing,
      queueLength,
      inFlightCount: inFlightSet.size,
      ts: Date.now(),
    });
    return;
  }

  // ── GET /queue ───────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/queue') {
    const items = await getPendingBatch(50);
    const sanitized = items.map(d => ({
      id       : d.id,
      target   : d.target,
      reaction : d.reaction,
      isDone   : d.isDone,
      createdAt: d.createdAt,
    }));
    json(res, 200, { isProcessing, queueLength: sanitized.length, queue: sanitized });
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

    // 5. Fingerprint rate limit
    const fp      = (req.headers['x-fp'] || '').trim();
    const fpCheck = await checkFpLimit(fp);
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

    // 7. Duplicate URL check (isDone == false)
    const isDup = await isDuplicateUrl(body.url);
    if (isDup) {
      return json(res, 409, { error: 'URL ini sudah ada di antrian.' });
    }

    // ── Masukkan ke antrian ──
    const id = await enqueue(body.url, body.reaction, fp, ip);
    await incrementFpCount(fp, fpCheck.count);

    // Trigger background worker
    processQueue().catch((e) => console.error('[Queue] Worker error:', e.message));

    const newPosition = queueCount + 1;
    console.log(`\n[React] Masuk antrian #${newPosition} | ID: ${id}`);

    json(res, 202, {
      statusCode : 202,
      status     : 'queued',
      isDone     : false,
      queueId    : id,
      position   : newPosition,
      message    : `Request masuk antrian posisi #${newPosition}`,
    });
    return;
  }

  // ── 404 ──────────────────────────────────────────────────
  json(res, 404, { error: 'Not found' });
});

// ── Realtime listener: hanya memantau isDone == false ──
function listenToQueue() {
  console.log('[Queue] Realtime listener aktif (menyimak dokumen isDone == false)...');

  db.collection(COLL)
    .where('isDone', '==', false)
    .onSnapshot((snapshot) => {
      // Saat dokumen diubah jadi isDone: true, doc tersebut keluar dari snapshot (type: 'removed')
      // dan TIDAK dihitung sebagai read berbayar tambahan oleh Firestore!
      const hasAdded = snapshot.docChanges().some(change => change.type === 'added');
      if (hasAdded && !isProcessing) {
        console.log(`[Queue] Ada item baru masuk antrian (${snapshot.size} pending). Memproses...`);
        processQueue().catch((e) => console.error('[Queue] Error:', e.message));
      }
    }, (err) => {
      console.error('[Queue] Firestore listener error:', err.message);
    });
}

// ── Auto-cleanup: bersihkan dokumen isDone == true yang berumur > 24 jam ──
async function cleanupOldCompletedItems() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snap = await db.collection(COLL)
      .where('isDone', '==', true)
      .where('doneAt', '<=', Timestamp.fromDate(oneDayAgo))
      .limit(50)
      .get();

    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`[Cleanup] Menghapus ${snap.size} dokumen riwayat selesai lama (> 24 jam)`);
    }
  } catch (err) {
    // Abaikan jika query membutuhkan index tambahan
  }
}

// ── Migrasi dokumen legacy saat boot ──
async function migrateLegacyDocsOnBoot() {
  try {
    const snap = await db.collection(COLL)
      .where('status', '==', 'pending')
      .limit(20)
      .get();

    if (!snap.empty) {
      console.log(`[Boot] Menemukan ${snap.size} dokumen legacy tanpa isDone, memperbarui...`);
      const batch = db.batch();
      snap.docs.forEach(doc => {
        batch.update(doc.ref, { isDone: false });
      });
      await batch.commit();
    }
  } catch (_) {
    // Abaikan jika sudah tidak ada dokumen legacy
  }
}

// ── Interval bersihkan ipTracker setiap 5 menit & cleanup Firestore setiap 6 jam ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipTracker.entries()) {
    if (now - rec.windowStart > IP_BURST_WINDOW * 2) ipTracker.delete(ip);
  }
}, 5 * 60 * 1000);

setInterval(() => {
  cleanupOldCompletedItems().catch(() => {});
}, 6 * 60 * 60 * 1000);

// ── Start Server ──
server.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Reaction Queue Backend v4 (Quota-Optimized)            ║');
  console.log(`║   Port        : ${PORT}                                     ║`);
  console.log('║   Queue       : Firebase Firestore (`react_queue`)       ║');
  console.log('║   Status Field: `isDone: false` (antre) / `true` (selesai)║');
  console.log(`║   Jeda Worker : ${QUEUE_DELAY / 1000}s per request                         ║`);
  console.log(`║   Daily Limit : ${DAILY_LIMIT}x per fingerprint                        ║`);
  console.log(`║   Max Queue   : ${MAX_QUEUE_SIZE} item                                  ║`);
  console.log(`║   Burst IP    : ${IP_BURST_LIMIT}x per menit                             ║`);
  console.log(`║   Auth Secret : ${PROXY_SECRET ? 'Aktif (X-Proxy-Secret) ✓' : 'TIDAK AKTIF ✗'}              ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  await migrateLegacyDocsOnBoot();
  await getActiveQueueCount(true);
  listenToQueue();
  cleanupOldCompletedItems().catch(() => {});
});
