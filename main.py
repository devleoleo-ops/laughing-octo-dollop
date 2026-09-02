import requests
import sys

API_BASE = "https://api-v1-kenz.edgeone.dev/api/v1"

API_KEY = "anzz_live_681308badc1bfce486024c2878d0e711014fde7626bbba50"

CHANNEL_URL = "https://whatsapp.com/channel/xxx"

REACTIONS = ["😊"]


COMMON_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
    "Origin": "https://kazehaya-rch.zone.id",
    "Referer": "https://kazehaya-rch.zone.id/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/151.0.0.0 Safari/537.36"
    ),
    "X-API-Key": API_KEY,
    "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}


# ============================================
# STEP 1 - HANDSHAKE
# ============================================

print("[1] Request handshake...")

try:
    hs_res = requests.post(
        f"{API_BASE}/handshake",
        headers=COMMON_HEADERS,
        data=b"",
        timeout=30,
    )

    print("Handshake HTTP:", hs_res.status_code)

    try:
        hs_data = hs_res.json()
    except Exception:
        print("Response handshake bukan JSON:")
        print(hs_res.text)
        sys.exit(1)

    print("Handshake:", hs_data)

    if not hs_res.ok or not hs_data.get("ok"):
        print("[ERROR] Handshake gagal")
        sys.exit(1)

    token = hs_data.get("token")

    if not token:
        print("[ERROR] Token handshake tidak ditemukan")
        sys.exit(1)

    print("[OK] Handshake berhasil")
    print("Token:", token)

except requests.RequestException as e:
    print("[ERROR] Handshake request error:")
    print(e)
    sys.exit(1)


# ============================================
# STEP 2 - SEND REACTION
# ============================================

print("\n[2] Mengirim reaction...")

react_headers = COMMON_HEADERS.copy()

react_headers["X-Handshake-Token"] = token
react_headers["Content-Type"] = "application/json"

payload = {
    "url": CHANNEL_URL,
    "reactions": REACTIONS,
}

try:
    react_res = requests.post(
        f"{API_BASE}/react",
        headers=react_headers,
        json=payload,
        timeout=30,
    )

    print("React HTTP:", react_res.status_code)

    try:
        react_data = react_res.json()
        print("React Response:", react_data)
    except Exception:
        print("React Body:", react_res.text)
        sys.exit(1)

    if not react_res.ok:
        print("[ERROR] Reaction gagal")
        sys.exit(1)

    print("[OK] Reaction berhasil dikirim")

except requests.RequestException as e:
    print("[ERROR] React request error:")
    print(e)
    sys.exit(1)