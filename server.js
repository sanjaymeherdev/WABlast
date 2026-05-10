require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL        = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve App
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WA Embedded Signup — Save Account
// Body: { code, user_id }
app.post('/api/wa/connect', async (req, res) => {
  const { code, user_id } = req.body;
  if (!code || !user_id) return res.status(400).json({ error: 'Missing code or user_id' });

  try {
    // Step 1 — Exchange code for access token
    const redirectUri = `${SELF_URL}/wa-callback`;
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      `client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) return res.status(400).json({ error: tokenData.error.message });

    const accessToken = tokenData.access_token;

    // Step 2 — Get WABA ID
    const wabaRes = await fetch(
      `https://graph.facebook.com/v19.0/me/businesses?access_token=${accessToken}`
    );
    const wabaData = await wabaRes.json();
    if (!wabaData.data || wabaData.data.length === 0)
      return res.status(400).json({ error: 'No WhatsApp Business Account found' });

    const wabaId = wabaData.data[0].id;

    // Step 3 — Get phone numbers
    const phoneRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers?access_token=${accessToken}`
    );
    const phoneData = await phoneRes.json();
    // Fallback to test number if no real numbers found
    const testNumber = {
      id: '1039250922613002',
      display_phone_number: '+1 555 642 4313',
      verified_name: 'Test Number',
      quality_rating: 'GREEN'
    };

    const phone = (phoneData.data && phoneData.data.length > 0)
      ? phoneData.data[0]
      : testNumber;

    // Step 4 — Save to Supabase
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        user_id,
        waba_id: wabaId,
        phone_number_id: phone.id,
        phone_number: phone.display_phone_number,
        display_name: phone.verified_name,
        access_token: accessToken,
        quality_rating: phone.quality_rating || 'GREEN',
        is_active: true
      })
    });

    const insertData = await insertRes.json();
    if (insertRes.status >= 400) return res.status(500).json({ error: 'Failed to save WA account' });

    res.json({ success: true, account: insertData[0] });
  } catch (err) {
    console.error('[wa/connect]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// WA Accounts — List for user
app.get('/api/wa/accounts', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/wa_accounts?user_id=eq.${user_id}&is_active=eq.true`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto Pinger
const PING_INTERVAL = 14 * 60 * 1000;
function startPinger() {
  setInterval(async () => {
    try {
      const r = await fetch(`${SELF_URL}/health`);
      console.log(`[pinger] ${new Date().toISOString()} — ${r.status}`);
    } catch (err) {
      console.error(`[pinger] failed:`, err.message);
    }
  }, PING_INTERVAL);
}

// Start
app.listen(PORT, () => {
  console.log(`WaBlast running on ${SELF_URL}`);
  startPinger();
});

// WA OAuth Callback Page — receives code from Meta, passes to parent window
app.get('/wa-callback', (req, res) => {
  const code  = req.query.code  || '';
  const error = req.query.error || '';

  const html = `<!DOCTYPE html>
<html><body>
<script>
  var code  = ${JSON.stringify(code)};
  var error = ${JSON.stringify(error)};
  if (error) {
    window.opener && window.opener.postMessage({ type: 'WA_ERROR', error: error }, '*');
  } else if (code) {
    window.opener && window.opener.postMessage({ type: 'WA_CODE', code: code }, '*');
  }
  setTimeout(function(){ window.close(); }, 300);
<\/script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px;">Connecting WhatsApp... closing window.</p>
</body></html>`;

  res.send(html);
});
