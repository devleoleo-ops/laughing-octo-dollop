'use strict';

/**
 * POST /api/submit-react
 *
 * Endpoint submit reaction dengan full security layer:
 *   1. Bot UA check
 *   2. Origin / Referer check
 *   3. Browser fingerprint (Sec-Fetch-*)
 *   4. CSRF token + JS challenge answer
 *   5. X-Requested-With header
 *   6. Daily limit per fingerprint (Firestore cooldowns — shared dg frontend)
 *   7. IP rate limit per hari (Firestore ip_limits)
 *   8. Global queue size cap (MAX_QUEUE)
 *   9. Duplicate URL check
 *  10. Validasi format URL (harus ada nomor post /187)
 *
 * Request body:
 *   { url, reaction, fingerprint }
 *
 * Response:
 *   { statusCode: 202, status: "queued", queueId, position }
 */

const { securityCheck, getClientIP, hashIP, applyCors, verifyRecaptcha } = require('./_utils/security');
const { getDb } = require('./_utils/firebase');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

// ── Config ────────────────────────────────────────────────────
const DAILY_LIMIT    = parseInt(process.env.DAILY_LIMIT    || '3',  10);
const MAX_QUEUE      = parseInt(process.env.MAX_QUEUE_SIZE || '20', 10);
const COLL_QUEUE     = 'react_queue';
const COLL_COOL      = 'cooldowns';
const COLL_IP        = 'ip_limits';

// ── Regex: URL harus punya nomor post (/187, dll) ─────────────
const POST_URL_RE = /whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/\d+/;

// Midnight 00:00 WIB (UTC+7) — fixed, tidak tergantung timezone server
const WIB_OFFSET = 7 * 60 * 60 * 1000;
const DAY_MS     = 86_400_000;
function todayMidnightMs() {
  return Math.floor((Date.now() + WIB_OFFSET) / DAY_MS) * DAY_MS - WIB_OFFSET;
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = getDb();

    // ── 1–5: Full security check (bot, origin, fingerprint, CSRF, XHR) ──
    const blocked = securityCheck(req);
    if (blocked)
      return res.status(blocked.status).json({ error: blocked.error, code: blocked.code });

    // ── Parse body & client IP ───────────────────────────────
    const { url: postUrl, reaction, fingerprint, recaptcha } = req.body || {};
    const clientIP = getClientIP(req);

    if (!postUrl || !reaction)
      return res.status(400).json({ error: 'Field "url" dan "reaction" wajib diisi.' });

    // ── reCAPTCHA v2 verify ──────────────────────────
    if (!recaptcha)
      return res.status(400).json({ error: 'Selesaikan verifikasi reCAPTCHA.', code: 'MISSING_CAPTCHA' });

    const captchaOk = await verifyRecaptcha(recaptcha, clientIP);
    if (!captchaOk)
      return res.status(403).json({ error: 'Verifikasi reCAPTCHA gagal atau expired. Coba lagi.', code: 'INVALID_CAPTCHA' });

    if (!POST_URL_RE.test(postUrl))
      return res.status(400).json({
        error: 'Format URL salah. Harus menyertakan nomor post. Contoh: https://whatsapp.com/channel/xxx/187',
        code : 'INVALID_URL_FORMAT',
      });

    if (typeof reaction !== 'string' || !reaction.trim())
      return res.status(400).json({ error: '"reaction" harus berupa string emoji.' });

    // ── 6: Daily limit per fingerprint ───────────────────────
    const fp = (fingerprint || '').toString().trim().slice(0, 128);

    if (fp.length >= 8) {
      const cdSnap = await db.collection(COLL_COOL).doc(fp).get();
      if (cdSnap.exists) {
        const data     = cdSnap.data();
        const todayMs  = todayMidnightMs();
        const dayStart = data.dayStartAt instanceof Timestamp
          ? data.dayStartAt.toMillis()
          : (data.dayStartAt?.seconds ? data.dayStartAt.seconds * 1000 : 0);

        if (dayStart >= todayMs && (data.count ?? 0) >= DAILY_LIMIT) {
          return res.status(429).json({
            error: `Limit ${DAILY_LIMIT}x/hari sudah tercapai. Coba lagi besok.`,
            code : 'FP_LIMIT_EXCEEDED',
          });
        }
      }
    }

    // ── 7: IP rate limit per hari ─────────────────────────────
    const ipHash   = hashIP(clientIP);
    const ipRef    = db.collection(COLL_IP).doc(ipHash);
    const ipSnap   = await ipRef.get();

    if (ipSnap.exists) {
      const ipData   = ipSnap.data();
      const resetAt  = ipData.resetAt?.toDate?.();
      if (resetAt && Date.now() < resetAt.getTime()) {
        const hoursLeft = Math.ceil((resetAt.getTime() - Date.now()) / 3_600_000);
        return res.status(429).json({
          error: `Sudah submit hari ini. Coba lagi dalam ${hoursLeft} jam.`,
          code : 'IP_LIMIT_EXCEEDED',
        });
      }
    }

    // ── 8: Global queue size cap ──────────────────────────────
    const [pendSnap, procSnap] = await Promise.all([
      db.collection(COLL_QUEUE).where('status', '==', 'pending').count().get(),
      db.collection(COLL_QUEUE).where('status', '==', 'processing').count().get(),
    ]);
    const queueCount = pendSnap.data().count + procSnap.data().count;

    if (queueCount >= MAX_QUEUE)
      return res.status(503).json({
        error   : 'Antrian sedang penuh. Coba lagi beberapa menit.',
        code    : 'QUEUE_FULL',
        queueLen: queueCount,
      });

    // ── 9: Duplicate URL check ────────────────────────────────
    const dupSnap = await db.collection(COLL_QUEUE)
      .where('target', '==', postUrl)
      .where('status', '==', 'pending')
      .limit(1).get();

    if (!dupSnap.empty)
      return res.status(409).json({
        error: 'URL ini sudah ada di antrian.',
        code : 'DUPLICATE_URL',
      });

    // ── 10: Simpan ke Firestore queue ─────────────────────────
    const docRef = await db.collection(COLL_QUEUE).add({
      target    : postUrl,
      reaction  : reaction.trim(),
      status    : 'pending',
      fp        : fp || null,
      ipHash,
      createdAt : FieldValue.serverTimestamp(),
      updatedAt : FieldValue.serverTimestamp(),
    });

    // Update FP daily counter (pakai koleksi `cooldowns` yang sama dg frontend)
    if (fp.length >= 8) {
      const todayTs = Timestamp.fromMillis(todayMidnightMs());
      await db.collection(COLL_COOL).doc(fp).set({
        count      : FieldValue.increment(1),
        dayStartAt : todayTs,
        updatedAt  : FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    // Update IP limit (reset 24 jam ke depan)
    const resetAt = new Date(Date.now() + 86_400_000);
    await ipRef.set({
      lastSubmit : FieldValue.serverTimestamp(),
      resetAt    : Timestamp.fromDate(resetAt),
      ipHash,
      count      : FieldValue.increment(1),
    }, { merge: true });

    // ── Response ──────────────────────────────────────────────
    return res.status(202).json({
      statusCode : 202,
      status     : 'queued',
      queueId    : docRef.id,
      position   : queueCount + 1,
      message    : `Request masuk antrian posisi #${queueCount + 1}`,
    });

  } catch (err) {
    console.error('[submit-react] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
