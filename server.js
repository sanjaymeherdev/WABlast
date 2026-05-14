// server.js — WaBlast Express Server (Queue-based)
// Handles: static files, WA OAuth, webhooks, queue processing via Edge

require('dotenv').config()
const express = require('express')
const fetch = require('node-fetch')
const crypto = require('crypto')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// ================================================================
// ENV
// ================================================================
const SELF_URL            = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`
const META_APP_ID         = process.env.META_APP_ID
const META_APP_SECRET     = process.env.META_APP_SECRET
const META_VERIFY_TOKEN   = process.env.META_WEBHOOK_VERIFY_TOKEN
const META_API_VERSION    = 'v20.0'
const SUPABASE_URL        = process.env.SUPABASE_URL
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY
const EDGE_FN_URL         = `${SUPABASE_URL}/functions/v1/wablast`
const META_CONFIG_ID      = process.env.META_CONFIG_ID

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))
app.use(express.static(path.join(__dirname, 'public')))

// ================================================================
// HELPERS
// ================================================================
async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=representation',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
  catch (_) { return { ok: res.ok, status: res.status, data: text } }
}

// All edge calls from server.js use the service key — the edge function
// whitelists these actions before the user-JWT check.
async function callEdge(action, body = {}) {
  const res = await fetch(EDGE_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ action, ...body }),
  })
  return res.json()
}

function verifyMetaSignature(req) {
  const sigHeader = req.headers['x-hub-signature-256'] || ''
  if (!sigHeader) return false
  const expected = 'sha256=' + crypto
    .createHmac('sha256', META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected)) }
  catch (_) { return false }
}

// ================================================================
// ROUTES
// ================================================================
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
)
app.get('/',        (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')))
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')))

// ================================================================
// WA OAuth
// ================================================================
app.get('/wa-connect', (_req, res) => {
  if (!META_APP_ID) return res.status(500).send('META_APP_ID not configured')
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Connect WhatsApp</title>
<style>
  body{font-family:sans-serif;background:#0a0c12;color:#edf2f9;display:flex;
       flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;margin:0;gap:16px;}
  button{background:#25d366;color:#000;border:none;padding:14px 28px;
         border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;}
</style>
</head>
<body>
  <div style="font-size:32px">💬</div>
  <h2>Connect WhatsApp Number</h2>
  <button onclick="launchSignup()">Connect via Meta</button>
  <div id="status"></div>
<script>
  window.fbAsyncInit = function() {
    FB.init({ appId: '${META_APP_ID}', cookie: true, xfbml: true, version: '${META_API_VERSION}' })
  };
  (function(d,s,id){
    var js, fjs = d.getElementsByTagName(s)[0]
    if (d.getElementById(id)) return
    js = d.createElement(s); js.id = id
    js.src = 'https://connect.facebook.net/en_US/sdk.js'
    fjs.parentNode.insertBefore(js, fjs)
  }(document, 'script', 'facebook-jssdk'))

  function setStatus(msg) { document.getElementById('status').textContent = msg }

  function launchSignup() {
    setStatus('Opening Meta login...')
    document.querySelector('button').disabled = true
    FB.login(function(response) {
      if (response.authResponse) {
        var code = response.authResponse.code
        setStatus('Connected! Saving...')
        if (window.opener) window.opener.postMessage({ type: 'WA_CODE', code: code }, '*')
        setStatus('Done! You can close this window.')
        setTimeout(function() { window.close() }, 1500)
      } else {
        setStatus('Cancelled')
        document.querySelector('button').disabled = false
      }
    }, {
      config_id: '${META_CONFIG_ID}',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: '', sessionInfoVersion: '3' }
    })
  }
<\/script>
</body></html>`)
})

app.get('/wa-callback', (req, res) => {
  const code  = req.query.code  || ''
  const error = req.query.error || ''
  res.send(`<!DOCTYPE html><html><body><script>
    var code = ${JSON.stringify(code)}, error = ${JSON.stringify(error)}
    if (error) window.opener?.postMessage({ type: 'WA_ERROR', error: error }, '*')
    else if (code) window.opener?.postMessage({ type: 'WA_CODE', code: code }, '*')
    setTimeout(() => window.close(), 800)
  <\/script><p>Connecting... closing window.</p></body></html>`)
})

app.post('/api/wa/connect', async (req, res) => {
  const { code, user_id } = req.body
  if (!code || !user_id) return res.status(400).json({ error: 'Missing code or user_id' })

  try {
    // Exchange code for token
    const tokenRes  = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token` +
      `?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${encodeURIComponent(code)}`
    )
    const tokenData = await tokenRes.json()
    if (tokenData.error) return res.status(400).json({ error: tokenData.error.message })

    const accessToken = tokenData.access_token

    // Get WABA
    const wabaRes  = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/me/whatsapp_business_accounts`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    )
    const wabaData = await wabaRes.json()
    const wabaId   = wabaData.data?.[0]?.id
    if (!wabaId) return res.status(400).json({ error: 'No WABA found' })

    // Get phone numbers
    const phoneRes  = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/phone_numbers` +
      `?fields=id,display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    )
    const phoneData = await phoneRes.json()
    const phone     = phoneData.data?.[0]
    if (!phone) return res.status(400).json({ error: 'No phone numbers found' })

    // Subscribe app to WABA
    await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/subscribed_apps`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}` } }
    )

    // Save to DB
    const insertRes = await sbFetch('/wa_accounts', {
      method: 'POST',
      body: JSON.stringify({
        user_id,
        waba_id:         wabaId,
        phone_number_id: phone.id,
        phone_number:    phone.display_phone_number,
        display_name:    phone.verified_name,
        access_token:    accessToken,
        quality_rating:  phone.quality_rating || 'GREEN',
        is_active:       true,
        messages_sent_today: 0,
        last_reset_date: new Date().toISOString().split('T')[0],
        created_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
    })

    if (!insertRes.ok) return res.status(500).json({ error: 'Failed to save account' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ================================================================
// CAMPAIGN ENDPOINTS
// ================================================================

// Start — enqueue all contacts and begin processing
app.post('/api/campaign/start', async (req, res) => {
  const { campaign_id, user_id } = req.body
  if (!campaign_id || !user_id)
    return res.status(400).json({ error: 'campaign_id and user_id required' })

  const result = await callEdge('campaignEnqueue', { campaign_id, user_id })
  res.json(result)
})

// Pause — set campaign status to paused; processor checks this and skips
app.post('/api/campaign/pause', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })

  const result = await callEdge('campaignPause', { campaign_id })
  res.json(result)
})

// Stop — mark campaign as draft, delete pending queue items
app.post('/api/campaign/stop', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })

  const result = await callEdge('campaignStop', { campaign_id })
  res.json(result)
})

// Status — live stats for the send tab
app.get('/api/campaign/status/:campaign_id', async (req, res) => {
  const { campaign_id } = req.params
  const result = await callEdge('campaignQueueStatus', { campaign_id })
  res.json(result)
})

// ================================================================
// QUEUE PROCESSOR — called by internal setInterval every 2 seconds
// ================================================================
app.post('/api/queue/process', async (req, res) => {
  const result = await callEdge('campaignProcessQueue', {})
  res.json(result)
})

// ================================================================
// META WEBHOOK
// ================================================================
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN)
    return res.status(200).send(challenge)
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  res.sendStatus(200) // Acknowledge immediately

  if (!verifyMetaSignature(req)) return

  const body = req.body
  if (body.object !== 'whatsapp_business_account') return

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field === 'messages') {
        // Delivery status updates
        for (const status of (change.value?.statuses || [])) {
          await callEdge('internalDeliveryWebhook', {
            id:     status.id,
            status: status.status,
            errors: status.errors || [],
          }).catch(err => console.error('[webhook] delivery:', err.message))
        }
        // Incoming messages → auto-reply (handled inside edge)
        for (const msg of (change.value?.messages || [])) {
          await callEdge('internalIncomingMessage', {
            wabaId:  entry.id,
            message: msg,
            contact: change.value?.contacts?.[0] || {},
          }).catch(err => console.error('[webhook] incoming:', err.message))
        }
      } else if (change.field === 'message_template_status_update') {
        await callEdge('internalTemplateWebhook', change.value)
          .catch(err => console.error('[webhook] template:', err.message))
      }
    }
  }
})

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log(`WaBlast server running on ${SELF_URL}`)

  // Queue processor — fires every 2 seconds
  let processorBusy = false
  setInterval(async () => {
    if (processorBusy) return
    processorBusy = true
    try {
      await fetch(`${SELF_URL}/api/queue/process`, { method: 'POST' })
    } catch (err) {
      console.error('[queue] processor error:', err.message)
    } finally {
      processorBusy = false
    }
  }, 2000)

  // Self-pinger to prevent Render spin-down
  setInterval(async () => {
    try { await fetch(`${SELF_URL}/health`) } catch (_) {}
  }, 14 * 60 * 1000)
})
