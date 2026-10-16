# WhatsApp Reaction Queue Backend (v4 — Quota-Optimized)

Arsitektur hybrid:
1. **Vercel Serverless Functions (`/api/`)**: Menerima request dari frontend browser, memvalidasi reCAPTCHA v2, anti-bot, CSRF challenge, limit IP & Fingerprint, lalu memasukkan tugas ke Firestore (`react_queue`) dengan `isDone: false`.
2. **VPS Worker (`server.js`)**: Berjalan terus di VPS (misal via PM2/systemd), mendengarkan koleksi `react_queue` saat ada dokumen baru `isDone: false`, memanggil API WhatsApp dengan delay 10 detik, lalu memperbarui status menjadi `isDone: true`.

---

## 🚀 Peran & Status di Firebase Firestore

Koleksi: `react_queue`

| Field | Tipe | Penjelasan |
| :--- | :--- | :--- |
| **`isDone`** | `boolean` | **`false`** = masih dalam antrian (pending)<br>**`true`** = sudah selesai dikerjakan |
| `target` | `string` | URL WhatsApp Channel dengan nomor post (contoh: `/channel/xxx/187`) |
| `reaction` | `string` | Emoji reaksi (contoh: `🔥,❤️,👍`) |
| `success` | `boolean` | `true` jika API mengembalikan status berhasil, `false` jika gagal |
| `createdAt`| `timestamp`| Waktu masuk antrian |
| `doneAt` | `timestamp`| Waktu selesai dikerjakan |

---

## ⚡ Cara Kerja Penghematan Kuota Firestore (Quota Saver)

1. **Tanpa State "processing" di Firestore**:
   State sementara hanya disimpan di in-memory VPS (`inFlightSet`). Menghilangkan 50% write dan mencegah snapshot event berulang.
2. **Hanya 1x Write per Tugas**:
   Worker VPS hanya menulis 1 kali ke Firestore saat tugas selesai (`isDone: true`, `doneAt`, `success`).
3. **Listener Cerdas (`where('isDone', '==', false)`)**:
   Saat dokumen diubah jadi `isDone: true`, dokumen tersebut keluar dari filter query (event `removed`), sehingga **0 biaya read tambahan** dari Firestore.
4. **In-Memory Sorting & Batching**:
   Mengambil hingga 15-20 tugas sekaligus dan mengurutkannya di memori VPS, tidak query ulang database setiap 1 item selesai.
5. **In-Memory Cache untuk Health Check**:
   Endpoint `GET /status` menggunakan cache 5 detik agar bot / health check tidak memakan kuota Firestore read.
6. **Auto-Cleanup**:
   Worker otomatis membersihkan dokumen `isDone: true` yang berumur lebih dari 24 jam setiap 6 jam sekali.

---

## ⚙️ Environment Variables

### 1. Di Vercel (Project Settings → Environment Variables)
| Variable | Keterangan |
| :--- | :--- |
| `CSRF_SECRET` | Secret string random untuk CSRF |
| `IP_SALT` | Salt string untuk hashing IP client |
| `RECAPTCHA_SECRET` | Google reCAPTCHA v2 Secret Key |
| `ALLOWED_ORIGIN` | Domain web frontend kamu (contoh: `https://naomi-rch.zone.id`) |
| `DAILY_LIMIT` | Maksimal submit per hari per fingerprint (default: `3`) |
| `MAX_QUEUE_SIZE` | Maksimal antrian aktif (default: `20`) |
| `FIREBASE_PROJECT_ID` | `rch-kazehaya` |
| `FIREBASE_CLIENT_EMAIL` | Email service account Firebase |
| `FIREBASE_PRIVATE_KEY` | Private key service account (format newline `\n`) |
| *(opsional)* `FIREBASE_SERVICE_ACCOUNT` | JSON lengkap service account (alternatif dari 3 var di atas) |

### 2. Di VPS (File `backend/.env`)
| Variable | Keterangan |
| :--- | :--- |
| `PORT` | Port server (default: `3002`) |
| `PROXY_SECRET` | Secret key untuk auth header `X-Proxy-Secret` |
| `_API_BASE` | URL endpoint API WhatsApp (contoh: `https://api.jerexd.my.id/api/whatsapp/reactch`) |
| `_API_KEY` | API Key WhatsApp |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path ke file service account `.json` |
| `QUEUE_DELAY_MS` | Jeda antar request (default: `10000` = 10 detik) |
| `DAILY_LIMIT` | `3` |
| `MAX_QUEUE_SIZE` | `20` |
| `IP_BURST_LIMIT` | `5` (maks 5 request per menit per IP) |

---

## 🏃 Cara Menjalankan Worker di VPS

```bash
cd backend
npm install
node server.js
```

Untuk berjalan di background (rekomendasi menggunakan PM2):
```bash
npm install -g pm2
pm2 start server.js --name "wa-queue-worker"
pm2 save
pm2 startup
```
