// server.js — WaBlast Express Server (Queue-based v2) — FIXED
// Handles: static files, WA OAuth, webhooks, queue processing via Edge
// ✅ Added: comprehensive webhook logging, better error handling, debug helpers

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

const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'wablast-internal-secret'

async function callEdge(action, body = {}) {
  const res = await fetch(EDGE_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'Authorization':     `Bearer ${SUPABASE_KEY}`,
      'x-internal-secret': INTERNAL_SECRET,
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
// WA OAuth (unchanged)
// ================================================================
app.get('/wa-connect', (_req, res) => {
  if (!META_APP_ID) return res.status(500).send('META_APP_ID not configured')
  if (!META_CONFIG_ID) return res.status(500).send('META_CONFIG_ID not configured')
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Connect WhatsApp</title>
<style>
  body{font-family:sans-serif;background:#0a0c12;color:#edf2f9;display:flex;
       flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;margin:0;gap:16px;padding:20px;text-align:center;}
  button{background:#25d366;color:#000;border:none;padding:14px 28px;
         border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;
         transition:opacity .15s;}
  button:disabled{opacity:.5;cursor:not-allowed;}
  #status{font-size:13px;color:#7a90b0;min-height:20px;}
</style>
</head>
<body>
  <div style="font-size:40px">💬</div>
  <h2 style="font-size:20px;">Connect WhatsApp Business Number</h2>
  <p style="font-size:13px;color:#7a90b0;max-width:320px;">
    You'll be redirected to Meta to log in and connect your WhatsApp Business Account.
  </p>
  <button id="connectBtn" onclick="launchSignup()">Connect via Meta Login</button>
  <div id="status"></div>
<script>
  window.fbAsyncInit = function() {
    FB.init({ appId: '${META_APP_ID}', cookie: true, xfbml: true, version: '${META_API_VERSION}' })
    FB.AppEvents.logPageView()
  };
  (function(d,s,id){
    var js, fjs = d.getElementsByTagName(s)[0]
    if (d.getElementById(id)) return
    js = d.createElement(s); js.id = id
    js.src = 'https://connect.facebook.net/en_US/sdk.js'
    fjs.parentNode.insertBefore(js, fjs)
  }(document, 'script', 'facebook-jssdk'))

  function setStatus(msg, isErr) {
    var el = document.getElementById('status')
    el.textContent = msg
    el.style.color = isErr ? '#f04f6e' : '#7a90b0'
  }

  function launchSignup() {
    var btn = document.getElementById('connectBtn')
    btn.disabled = true
    setStatus('Opening Meta login…')
    FB.login(function(response) {
      if (response.authResponse) {
        var code = response.authResponse.code
        setStatus('✅ Connected! Saving your number…')
        if (window.opener) {
          window.opener.postMessage({ type: 'WA_CODE', code: code }, '*')
        }
        setStatus('Done! You can close this window.')
        setTimeout(function() { window.close() }, 2000)
      } else {
        setStatus('Login cancelled or failed. Please try again.', true)
        btn.disabled = false
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
    const tokenRes  = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token` +
      `?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${encodeURIComponent(code)}`
    )
    const tokenData = await tokenRes.json()
    if (tokenData.error) return res.status(400).json({ error: tokenData.error.message })

    const accessToken = tokenData.access_token

    const wabaRes  = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/me/whatsapp_business_accounts`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    )
    const wabaData = await wabaRes.json()
    const wabaId   = wabaData.data?.[0]?.id
    if (!wabaId) return res.status(400).json({ error: 'No WABA found' })

    const phoneRes  = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/phone_numbers` +
      `?fields=id,display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    )
    const phoneData = await phoneRes.json()
    const phone     = phoneData.data?.[0]
    if (!phone) return res.status(400).json({ error: 'No phone numbers found' })

    await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/subscribed_apps`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}` } }
    )

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
    console.error('[wa-connect] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ================================================================
// CAMPAIGN ENDPOINTS (v2)
// ================================================================

// Start — marks campaign as running (queue already exists)
app.post('/api/campaign/start', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })
  console.log('[campaign] start requested:', campaign_id)
  const result = await callEdge('campaignStart', { campaign_id })
  console.log('[campaign] start result:', { campaign_id, success: result.success, message: result.message })
  res.json(result)
})

// Delete campaign
app.post('/api/campaign/delete', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })
  console.log('[campaign] delete requested:', campaign_id)
  const result = await callEdge('deleteCampaign', { campaign_id })
  console.log('[campaign] delete result:', { campaign_id, success: result.success, refunded: result.refunded })
  res.json(result)
})

// Get active campaign
app.get('/api/campaign/active', async (_req, res) => {
  const result = await callEdge('getActiveCampaign', {})
  res.json(result)
})

// Pause
app.post('/api/campaign/pause', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })
  console.log('[campaign] pause requested:', campaign_id)
  const result = await callEdge('campaignPause', { campaign_id })
  console.log('[campaign] pause result:', { campaign_id, success: result.success })
  res.json(result)
})

// Stop
app.post('/api/campaign/stop', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })
  console.log('[campaign] stop requested:', campaign_id)
  const result = await callEdge('campaignStop', { campaign_id })
  console.log('[campaign] stop result:', { campaign_id, success: result.success, refunded: result.refunded })
  res.json(result)
})

// Status
app.get('/api/campaign/status/:campaign_id', async (req, res) => {
  const { campaign_id } = req.params
  const result = await callEdge('campaignQueueStatus', { campaign_id })
  res.json(result)
})

// ================================================================
// QUEUE PROCESSOR
// ================================================================
app.post('/api/queue/process', async (req, res) => {
  const result = await callEdge('campaignProcessQueue', {})
  res.json(result)
})

// ================================================================
// META WEBHOOK — ✅ FULLY LOGGED
// ================================================================
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[webhook] GET: verification successful, challenge sent')
    return res.status(200).send(challenge)
  }
  console.warn('[webhook] GET: verification FAILED', { mode, token_match: token === META_VERIFY_TOKEN })
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  // ✅ Log receipt FIRST (before sending 200)
  console.log('[webhook] POST received:', {
    timestamp: new Date().toISOString(),
    object: req.body?.object,
    entryCount: req.body?.entry?.length,
    ip: req.ip || req.headers['x-forwarded-for']?.split(',')[0],
    userAgent: req.headers['user-agent']?.substring(0, 50)
  })

  // ✅ Send 200 OK immediately per Meta requirement
  res.sendStatus(200)

  // ✅ Verify signature
  if (!verifyMetaSignature(req)) {
    console.warn('[webhook] signature verification FAILED', {
      hasSig: !!req.headers['x-hub-signature-256'],
      appSecretSet: !!META_APP_SECRET
    })
    return
  }
  console.log('[webhook] signature verified ✓')

  const body = req.body
  if (body.object !== 'whatsapp_business_account') {
    console.log('[webhook] ignored: not whatsapp_business_account', { object: body.object })
    return
  }

  for (const entry of (body.entry || [])) {
    const wabaId = entry.id
    for (const change of (entry.changes || [])) {
      const field = change.field
      const value = change.value

      // ── Messages field: delivery statuses + incoming messages ──
      if (field === 'messages') {
        // Delivery status updates
        for (const status of (value?.statuses || [])) {
          console.log('[webhook] delivery update:', {
            waMessageId: status.id,
            status: status.status,
            recipient: status.recipient_id,
            timestamp: status.timestamp,
            errors: status.errors?.[0]?.title || null,
            wabaId
          })
          callEdge('internalDeliveryWebhook', {
            id:     status.id,
            status: status.status,
            errors: status.errors || [],
          })
          .then(r => console.log('[webhook] delivery edge response:', { id: status.id, success: r.success }))
          .catch(err => console.error('[webhook] delivery edge ERROR:', err.message))
        }

        // Incoming messages from users
        for (const msg of (value?.messages || [])) {
          console.log('[webhook] incoming message:', {
            from: msg.from,
            type: msg.type,
            id: msg.id,
            timestamp: msg.timestamp,
            wabaId,
            contactName: value?.contacts?.[0]?.profile?.name
          })
          callEdge('internalIncomingMessage', {
            wabaId:  wabaId,
            message: msg,
            contact: value?.contacts?.[0] || {},
          })
          .then(r => console.log('[webhook] incoming edge response:', { from: msg.from, success: r.success }))
          .catch(err => console.error('[webhook] incoming edge ERROR:', err.message))
        }

      // ── Template status updates ──
      } else if (field === 'message_template_status_update') {
        console.log('[webhook] template status update:', {
          templateName: value?.message_template_name,
          templateId: value?.message_template_id,
          event: value?.event,
          reason: value?.reason,
          wabaId
        })
        callEdge('internalTemplateWebhook', value)
          .then(r => console.log('[webhook] template edge response:', { success: r.success }))
          .catch(err => console.error('[webhook] template edge ERROR:', err.message))

      // ── Other fields (log for debugging) ──
      } else {
        console.log('[webhook] unhandled field:', { field, wabaId })
      }
    }
  }
})

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log(`✅ WaBlast server running on ${SELF_URL}`)
  console.log(`   PORT: ${PORT}`)
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`)
  
 let processorBusy = false

// Queue processor — calls Edge function directly (no self-HTTP race condition)
// setTimeout delays first run until server is fully ready
setTimeout(() => {
  setInterval(async () => {
    if (processorBusy) return
    processorBusy = true
    try {
      const data = await callEdge('campaignProcessQueue', {})
      if (data?.processed > 0) {
        console.log('[queue] processed:', { sent: data.sent, failed: data.failed, phone: data.phone })
      }
    } catch (err) {
      console.error('[queue] processor error:', err.message)
    } finally {
      processorBusy = false
    }
  }, 3000)
}, 5000) // wait 5s after listen() before starting
  
  // Health check ping (every 14 min to keep Render awake)
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`)
      console.log('[health] ping sent')
    } catch (_) {}
  }, 14 * 60 * 1000)
})
