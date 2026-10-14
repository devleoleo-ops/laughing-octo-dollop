'use strict';

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

let _db = null;

/**
 * Lazy-init Firestore (singleton).
 * Credentials dibaca dari env vars — tidak pernah hardcoded.
 */
function getDb() {
  if (_db) return _db;

  if (!require('firebase-admin/app').getApps().length) {
    let sa;

    // Prioritas 1: JSON lengkap di env (untuk Vercel)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      try {
        sa = JSON.parse(raw);
      } catch {
        raw = raw.replace(/\\\\n/g, '\\n');
        sa  = JSON.parse(raw);
      }
      if (sa.private_key) {
        sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      }
    }

    // Prioritas 2: env vars terpisah
    if (!sa && process.env.FIREBASE_PROJECT_ID) {
      sa = {
        type         : 'service_account',
        project_id   : process.env.FIREBASE_PROJECT_ID,
        private_key  : process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email : process.env.FIREBASE_CLIENT_EMAIL,
      };
    }

    if (!sa) throw new Error('[firebase] Tidak ada credentials di environment variables.');

    initializeApp({ credential: cert(sa) });
  }

  _db = getFirestore();
  return _db;
}

module.exports = { getDb };
