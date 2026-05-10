require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Serve App ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Auto Pinger (keeps Render free tier alive) ───────────────
const PING_INTERVAL = 14 * 60 * 1000; // every 14 minutes

function startPinger() {
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      console.log(`[pinger] ${new Date().toISOString()} — status: ${res.status}`);
    } catch (err) {
      console.error(`[pinger] failed:`, err.message);
    }
  }, PING_INTERVAL);
}

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WaBlast running on ${SELF_URL}`);
  startPinger();
});
