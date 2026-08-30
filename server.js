import express from 'express';
import cors    from 'cors';
import fetch   from 'node-fetch';

const PORT = process.env.PORT || 3001;
const _t   = 'https://api-v1-kenz.edgeone.dev/api/v1';
const _k   = 'anzz_live_681308badc1bfce486024c2878d0e711014fde7626bbba50';
const _o   = 'https://kazehaya-rch.zone.id';

const _h = {
  'Origin'             : _o,
  'Referer'            : `${_o}/`,
  'User-Agent'         : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Sec-Ch-Ua'          : '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
  'Sec-Ch-Ua-Mobile'   : '?0',
  'Sec-Ch-Ua-Platform' : '"Windows"',
  'Sec-Fetch-Site'     : 'same-origin',
  'Sec-Fetch-Mode'     : 'cors',
  'Sec-Fetch-Dest'     : 'empty',
  'X-API-Key'          : _k,
};

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));

// GET /x/status
app.get('/x/status', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// POST /x/session/init
app.post('/x/session/init', async (_req, res) => {
  try {
    const r = await fetch(`${_t}/handshake`, { method: 'POST', headers: { ..._h } });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /x/session/commit
// body: { ref, payload, sig }
app.post('/x/session/commit', async (req, res) => {
  const { ref, payload, sig } = req.body ?? {};
  if (!ref || !payload || !sig) return res.status(400).json({ error: 'invalid' });
  try {
    const r = await fetch(`${_t}/react`, {
      method : 'POST',
      headers: { ..._h, 'Content-Type': 'application/json', 'X-Handshake-Token': sig },
      body   : JSON.stringify({ url: ref, reactions: payload }),
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /x/push
// body: { ref, payload }  ← all-in-one, paling praktis
app.post('/x/push', async (req, res) => {
  const { ref, payload } = req.body ?? {};
  if (!ref || !payload) return res.status(400).json({ error: 'invalid' });
  try {
    const hs = await fetch(`${_t}/handshake`, { method: 'POST', headers: { ..._h } });
    const hd = await hs.json();
    if (!hd?.token) return res.status(502).json({ error: 'init failed' });

    const rr = await fetch(`${_t}/react`, {
      method : 'POST',
      headers: { ..._h, 'Content-Type': 'application/json', 'X-Handshake-Token': hd.token },
      body   : JSON.stringify({ url: ref, reactions: payload }),
    });
    const rd = await rr.json();
    res.status(rr.status).json({ ok: rr.ok, ...rd });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`listening :${PORT}`));
