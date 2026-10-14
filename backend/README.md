# WhatsApp Reaction Queue Backend

Backend proxy server untuk mengirimkan reaction ke WhatsApp Channel melalui VPS API, dengan sistem antrian FIFO dan jeda 10 detik antar request.

## Cara Jalankan

```bash
cd backend
node server.js
# atau
npm start
```

Server akan berjalan di port **3002** (bisa diganti via env `PORT`).

## Endpoints

### `GET /status`
Cek status server dan jumlah antrian.

```json
{
  "status": "ok",
  "queueLength": 2,
  "isProcessing": true,
  "ts": 1728800000000
}
```

---

### `GET /queue`
Lihat isi antrian saat ini.

```json
{
  "isProcessing": true,
  "queueLength": 2,
  "queue": [
    { "id": "q2_1728800000", "target": "https://...", "reaction": "😭🥹" }
  ]
}
```

---

### `POST /react` — Async (langsung balas)
Tambah request ke antrian. Server langsung balas 202 tanpa menunggu.

**Request:**
```json
{
  "url": "https://whatsapp.com/channel/0029VbCAVC5DOQIadz9p6l3I/187",
  "reaction": "😭🥹🙃"
}
```

**Response (202):**
```json
{
  "statusCode": 202,
  "status": "queued",
  "queueId": "q1_1728800000",
  "position": 1,
  "message": "Request masuk antrian posisi #1"
}
```

---

### `POST /react/sync` — Sync (tunggu hasil)
Tambah ke antrian dan **tunggu** sampai selesai diproses.

**Response (200):**
```json
{
  "statusCode": 200,
  "target": "https://whatsapp.com/channel/xxx/187",
  "reaction": "😭🥹🙃",
  "status": "success"
}
```

## Validasi URL

URL wajib menyertakan nomor post:
- ✅ `https://whatsapp.com/channel/0029VbCAVC5DOQIadz9p6l3I/187`
- ❌ `https://whatsapp.com/channel/0029VbCAVC5DOQIadz9p6l3I/`

## Cara Kerja Queue

1. Request masuk → push ke array `queue[]`
2. Worker berjalan, ambil item pertama (`shift`)
3. Hit VPS API
4. Tunggu 10 detik
5. Proses item berikutnya, dst.
