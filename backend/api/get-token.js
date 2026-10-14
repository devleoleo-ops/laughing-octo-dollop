'use strict';

/**
 * GET /api/get-token
 *
 * Mengembalikan CSRF token + JS challenge ke client.
 * Token di-bind ke IP client (HMAC-SHA256).
 * Client harus eval(challenge) di browser dan kirim hasilnya
 * sebagai X-Challenge-Answer saat submit.
 *
 * Checks dilakukan di sini:
 *   - Bot user-agent
 *   - Origin / Referer valid
 *   - Browser fingerprint (Sec-Fetch-*)
 */

const {
  applyCors,
  isBot,
  checkOrigin,
  validateBrowserFingerprint,
  generateCsrfToken,
  getClientIP,
  hashIP,
} = require('./_utils/security');

const BLOCKED_MSG = 'Akses ditolak. Gunakan web resmi.';

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  // 1. Bot check
  const botCheck = isBot(req);
  if (botCheck.isBot)
    return res.status(403).json({ error: BLOCKED_MSG, code: 'BOT_DETECTED' });

  // 2. Origin / Referer check
  if (!checkOrigin(req))
    return res.status(403).json({ error: BLOCKED_MSG, code: 'INVALID_ORIGIN' });

  // 3. Browser fingerprint
  const bfp = validateBrowserFingerprint(req);
  if (!bfp.valid)
    return res.status(403).json({ error: BLOCKED_MSG, code: 'INVALID_BROWSER' });

  // 4. Generate IP-bound CSRF token + JS challenge
  const clientIP = getClientIP(req);
  const ipHash   = hashIP(clientIP);
  const csrf     = generateCsrfToken(ipHash);

  return res.status(200).json({
    success   : true,
    token     : csrf.token,
    challenge : csrf.challenge,
  });
};
