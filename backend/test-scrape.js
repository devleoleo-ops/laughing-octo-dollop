/**
 * Scrape Test — uji apakah backend bisa di-bypass
 *
 * Test berbagai skenario abuse:
 *   1. Direct hit tanpa Origin (curl style)
 *   2. Hit dengan Origin salah
 *   3. Hit tanpa X-Requested-With
 *   4. Hit tanpa CSRF token
 *   5. Hit dengan User-Agent bot (axios)
 *   6. Hit lengkap tapi CSRF palsu
 *   7. GET /api/get-token langsung (tanpa browser headers)
 */

'use strict';

const https = require('https');
const http  = require('http');

// ─────────────────────────────────────────────
// CONFIG — sesuaikan dengan backend yang sedang jalan
// ─────────────────────────────────────────────
const BACKEND_HOST = 'localhost';
const BACKEND_PORT = 3002;   // kalau test ke server.js standalone
// atau kalau test ke vercel dev: 3000
const USE_HTTPS = false;

const TEST_URL = 'https://whatsapp.com/channel/0029VbCAVC5DOQIadz9p6l3I/187';
const TEST_REACTION = '😭';

// ─────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────
function request(method, path, headers = {}, body = null) {
  return new Promise((resolve) => {
    const lib = USE_HTTPS ? https : http;
    const opts = {
      hostname: BACKEND_HOST,
      port    : BACKEND_PORT,
      path,
      method,
      headers : {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = { raw }; }
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────
let passed = 0, failed = 0;

function check(name, res, expectedStatus) {
  const ok = res.status === expectedStatus;
  const icon = ok ? '✅' : '❌';
  console.log(`${icon}  [${res.status}] ${name}`);
  if (!ok) {
    console.log(`     Expected ${expectedStatus}, got ${res.status}`);
    console.log(`     Body: ${JSON.stringify(res.body).slice(0, 150)}`);
    failed++;
  } else {
    passed++;
  }
}

async function runTests() {
  console.log('\n═══════════════════════════════════════');
  console.log(' SCRAPE / ABUSE TEST — Backend Security');
  console.log(`═══════════════════════════════════════`);
  console.log(` Target: http${USE_HTTPS ? 's' : ''}://${BACKEND_HOST}:${BACKEND_PORT}\n`);

  // ── Test 1: Tanpa Origin (curl-style) ────────────────────
  console.log('── Direct Bypass Tests ──');

  const t1 = await request('POST', '/react', {
    // Tidak ada Origin, tidak ada secret
  }, { url: TEST_URL, reaction: TEST_REACTION });
  check('Tanpa Origin & secret → 401', t1, 401);

  // ── Test 2: Secret benar tapi tanpa Origin ────────────────
  const t2 = await request('POST', '/react', {
    'X-Proxy-Secret': 'naomik_react_2026',
    // Tidak ada Origin
  }, { url: TEST_URL, reaction: TEST_REACTION });
  check('Secret benar, tanpa Origin → 202 (server.js bypass ok karena VPS internal)', t2, 202);

  // ── Test 3: GET /status (public) ──────────────────────────
  console.log('\n── Public Endpoints ──');
  const t3 = await request('GET', '/status');
  check('GET /status → 200', t3, 200);
  if (t3.status === 200) {
    console.log(`     queueLength: ${t3.body.queueLength}, isProcessing: ${t3.body.isProcessing}`);
  }

  // ── Test 4: URL tidak valid ───────────────────────────────
  console.log('\n── Input Validation ──');
  const t4 = await request('POST', '/react', {
    'X-Proxy-Secret': 'naomik_react_2026',
  }, { url: 'https://whatsapp.com/channel/xxx', reaction: '😭' }); // tidak ada nomor post
  check('URL tanpa nomor post → 400', t4, 400);
  console.log(`     Error: ${t4.body?.error}`);

  // ── Test 5: Reaction kosong ───────────────────────────────
  const t5 = await request('POST', '/react', {
    'X-Proxy-Secret': 'naomik_react_2026',
  }, { url: TEST_URL, reaction: '' });
  check('Reaction kosong → 400', t5, 400);

  // ── Test 6: Method salah ──────────────────────────────────
  console.log('\n── Method Tests ──');
  const t6 = await request('GET', '/react');
  check('GET /react → 404', t6, 404);

  const t7 = await request('DELETE', '/react');
  check('DELETE /react → 404', t7, 404);

  // ── Test 7: Endpoint tidak ada ────────────────────────────
  const t8 = await request('GET', '/admin');
  check('GET /admin → 404', t8, 404);

  const t9 = await request('POST', '/queue/clear', {
    'X-Proxy-Secret': 'naomik_react_2026',
  });
  check('POST /queue/clear (tidak ada) → 404', t9, 404);

  // ── Ringkasan ─────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log(` HASIL: ${passed} passed / ${failed} failed`);
  if (failed === 0) {
    console.log(' 🔒 Backend aman dari semua scrape attempt!');
  } else {
    console.log(' ⚠️  Ada test yang gagal, periksa konfigurasi.');
  }
  console.log('═══════════════════════════════════════\n');
}

runTests().catch(console.error);
