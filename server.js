// server.js — WaBlast Express Server
// Handles: static files, WA Embedded Signup OAuth, Meta webhooks,
//          campaign queue worker, self-pinger
//
// Deployed on Render (persistent Node process — ideal for long-running workers)

require('dotenv').config()
const express    = require('express')
const fetch      = require('node-fetch')
const crypto     = require('crypto')
const path       = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// ================================================================
// ENV
// ================================================================
const SELF_URL          = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`
const META_APP_ID       = process.env.META_APP_ID
const META_APP_SECRET   = process.env.META_APP_SECRET
const META_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN  // you set this in Meta App Dashboard
const META_API_VERSION  = 'v20.0'
const SUPABASE_URL      = process.env.SUPABASE_URL
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY        // service role key
const EDGE_FN_URL       = `${SUPABASE_URL}/functions/v1/wablast`
const META_CONFIG_ID = process.env.META_CONFIG_ID
// Campaign worker config
const WORKER_POLL_MS    = 5000   // check queue every 5 seconds
const MSG_MIN_DELAY_MS  = 5000   // min delay between messages (5s)
const MSG_MAX_DELAY_MS  = 15000  // max delay between messages (15s)
const MSG_BATCH_SIZE    = 1      // process one message at a time per worker tick

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(express.json({
  // Keep raw body for Meta webhook signature verification
  verify: (req, _res, buf) => { req.rawBody = buf }
}))
app.use(express.static(path.join(__dirname, 'public')))

// ================================================================
// HELPERS
// ================================================================

// Direct Supabase REST call (service role — bypasses RLS)
async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`
  const res  = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=representation',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }
  } catch (_) { return { ok: res.ok, status: res.status, data: text } }
}

// Call our own edge function as internal service (service key auth)
async function callEdgeInternal(action, body = {}) {
  const res = await fetch(EDGE_FN_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ action, ...body }),
  })
  return res.json()
}

// Meta Graph API call
async function metaFetch(path, method = 'GET', body, token) {
  const url     = path.startsWith('http')
    ? path
    : `https://graph.facebook.com/${META_API_VERSION}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res  = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

// Verify Meta webhook signature
function verifyMetaSignature(req) {
  const sigHeader = req.headers['x-hub-signature-256'] || ''
  if (!sigHeader) return false
  const expected = 'sha256=' +
    crypto.createHmac('sha256', META_APP_SECRET)
          .update(req.rawBody)
          .digest('hex')
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sigHeader),
      Buffer.from(expected)
    )
  } catch (_) { return false }
}

// Random delay
function randomDelay(min, max) {
  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
  )
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    worker:    workerRunning,
  })
})

// ================================================================
// SERVE APP
// ================================================================
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ================================================================
// WA EMBEDDED SIGNUP — STEP 1
// Frontend opens a popup to this URL which loads the Meta JS SDK
// and launches the Facebook Login for Business flow.
// ================================================================
app.get('/wa-connect', (_req, res) => {
  if (!META_APP_ID) {
    return res.status(500).send('META_APP_ID not configured')
  }

  // This page loads inside a popup.
  // It uses the Meta JS SDK to launch Embedded Signup, then
  // posts the short-lived code back to the opener via postMessage.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Connect WhatsApp</title>
  <style>
    body {
      font-family: sans-serif;
      background: #0a0c12;
      color: #edf2f9;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      gap: 16px;
    }
    .logo { font-size: 32px; }
    p { color: #8e9cb0; font-size: 14px; text-align: center; }
    button {
      background: #25d366;
      color: #000;
      border: none;
      padding: 14px 28px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    button:hover { background: #20bf5a; }
    #status { font-size: 13px; color: #8e9cb0; min-height: 20px; }
  </style>
</head>
<body>
  <div class="logo">💬</div>
  <h2 style="margin:0">Connect WhatsApp Number</h2>
  <p>Click below to connect your WhatsApp Business number via Meta.</p>
  <button id="connectBtn" onclick="launchSignup()">
    Connect via Meta
  </button>
  <div id="status"></div>

  <script>
    // Load Meta JS SDK
    window.fbAsyncInit = function() {
      FB.init({
        appId:   '${META_APP_ID}',
        cookie:  true,
        xfbml:   true,
        version: '${META_API_VERSION}',
      })
    };

    (function(d, s, id) {
      var js, fjs = d.getElementsByTagName(s)[0]
      if (d.getElementById(id)) return
      js = d.createElement(s); js.id = id
      js.src = 'https://connect.facebook.net/en_US/sdk.js'
      fjs.parentNode.insertBefore(js, fjs)
    }(document, 'script', 'facebook-jssdk'))

    function setStatus(msg) {
      document.getElementById('status').textContent = msg
    }

    function launchSignup() {
      setStatus('Opening Meta login...')
      document.getElementById('connectBtn').disabled = true

      FB.login(function(response) {
        if (response.authResponse) {
          var code = response.authResponse.code
          setStatus('Connected! Saving your number...')
          // Send code to opener (the main WaBlast tab)
          if (window.opener) {
            window.opener.postMessage({ type: 'WA_CODE', code: code }, '*')
          }
          setStatus('Done! You can close this window.')
          setTimeout(function() { window.close() }, 1500)
        } else {
          setStatus('Connection cancelled or failed. Please try again.')
          document.getElementById('connectBtn').disabled = false
        }
      }, {
        config_id:     '${META_CONFIG_ID}',
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup:    {},
          featureType: '',
          sessionInfoVersion: '3',
        }
      })
    }
  </script>
</body>
</html>`

  res.send(html)
})

// ================================================================
// WA EMBEDDED SIGNUP — STEP 2 (OAuth callback, alternative flow)
// Meta redirects here after login if using redirect_uri instead of JS SDK.
// Posts the code back to the opener via postMessage then closes.
// ================================================================
app.get('/wa-callback', (req, res) => {
  const code  = req.query.code  || ''
  const error = req.query.error || ''

  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0a0c12;color:#edf2f9;text-align:center;padding-top:60px;">
<script>
  var code  = ${JSON.stringify(code)}
  var error = ${JSON.stringify(error)}
  if (error) {
    window.opener && window.opener.postMessage({ type: 'WA_ERROR', error: error }, '*')
  } else if (code) {
    window.opener && window.opener.postMessage({ type: 'WA_CODE', code: code }, '*')
  }
  setTimeout(function(){ window.close() }, 800)
<\/script>
<p>Connecting WhatsApp… closing window.</p>
</body></html>`

  res.send(html)
})

// ================================================================
// WA EMBEDDED SIGNUP — STEP 3
// Frontend calls this after receiving WA_CODE from the popup.
// Exchanges code → token → WABA → phone numbers → saves to Supabase.
// ================================================================
app.post('/api/wa/connect', async (req, res) => {
  const { code, user_id } = req.body
  if (!code || !user_id)
    return res.status(400).json({ error: 'Missing code or user_id' })

  try {
    // Step 1 — Exchange short-lived code for access token
    const redirectUri = `${SELF_URL}/wa-callback`
    const tokenRes = await metaFetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token` +
      `?client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&code=${encodeURIComponent(code)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`
    )
    if (!tokenRes.ok || tokenRes.data.error)
      return res.status(400).json({ error: tokenRes.data.error?.message || 'Token exchange failed' })

    const accessToken = tokenRes.data.access_token

    // Step 2 — Get WhatsApp Business Accounts (correct endpoint)
    const wabaRes = await metaFetch(
      '/me/whatsapp_business_accounts?fields=id,name,currency,timezone_id',
      'GET',
      undefined,
      accessToken
    )

    if (!wabaRes.ok || !wabaRes.data.data?.length) {
      // Fallback: try getting WABA via business portfolio
      const bizRes = await metaFetch(
        '/me/businesses?fields=id,name',
        'GET',
        undefined,
        accessToken
      )

      if (!bizRes.ok || !bizRes.data.data?.length)
        return res.status(400).json({ error: 'No WhatsApp Business Account found. Make sure your Meta Business account has a WABA.' })

      // Get WABAs for each business
      const bizId     = bizRes.data.data[0].id
      const wabaList  = await metaFetch(
        `/${bizId}/owned_whatsapp_business_accounts?fields=id,name`,
        'GET',
        undefined,
        accessToken
      )
      if (!wabaList.ok || !wabaList.data.data?.length)
        return res.status(400).json({ error: 'No WABA found under your business.' })

      wabaRes.data = wabaList.data
    }

    const wabaId = wabaRes.data.data[0].id

    // Step 3 — Get phone numbers for this WABA
    const phoneRes = await metaFetch(
      `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status`,
      'GET',
      undefined,
      accessToken
    )

    if (!phoneRes.ok || !phoneRes.data.data?.length)
      return res.status(400).json({ error: 'No phone numbers found for this WABA.' })

    const phone = phoneRes.data.data[0]

    // Step 4 — Subscribe this WABA to our app's webhook
    // This is required for Meta to send us webhooks for this account
    await metaFetch(
      `/${wabaId}/subscribed_apps`,
      'POST',
      undefined,
      accessToken
    )

    // Step 5 — Save to Supabase (upsert on phone_number_id)
    const insertRes = await sbFetch('/wa_accounts', {
      method:  'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body:    JSON.stringify({
        user_id,
        waba_id:           wabaId,
        phone_number_id:   phone.id,
        phone_number:      phone.display_phone_number,
        display_name:      phone.verified_name,
        access_token:      accessToken,
        quality_rating:    phone.quality_rating || 'GREEN',
        is_active:         true,
        updated_at:        new Date().toISOString(),
        created_at:        new Date().toISOString(),
      }),
    })

    if (!insertRes.ok)
      return res.status(500).json({ error: 'Failed to save WA account to database.' })

    const account = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data

    res.json({ success: true, account })

  } catch (err) {
    console.error('[/api/wa/connect]', err.message)
    res.status(500).json({ error: 'Internal server error: ' + err.message })
  }
})

// ================================================================
// WA ACCOUNTS — LIST (used by frontend directly as fallback)
// ================================================================
app.get('/api/wa/accounts', async (req, res) => {
  const { user_id } = req.query
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' })

  try {
    const r = await sbFetch(
      `/wa_accounts?user_id=eq.${user_id}&is_active=eq.true&order=created_at.desc`
    )
    res.json(r.data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ================================================================
// META WEBHOOK — VERIFICATION (GET)
// Meta sends a GET with hub.challenge to verify the endpoint.
// Set META_WEBHOOK_VERIFY_TOKEN in your .env and in the Meta App Dashboard.
// ================================================================
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[webhook] Verified by Meta')
    return res.status(200).send(challenge)
  }
  console.warn('[webhook] Verification failed — token mismatch')
  res.sendStatus(403)
})

// ================================================================
// META WEBHOOK — EVENTS (POST)
// Handles all incoming webhook events from Meta.
// ================================================================
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately — Meta retries if we take > 5s
  res.sendStatus(200)

  // Verify signature
  if (!verifyMetaSignature(req)) {
    console.warn('[webhook] Invalid signature — ignoring')
    return
  }

  const body = req.body
  if (body.object !== 'whatsapp_business_account') return

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      const field = change.field
      const value = change.value

      try {
        if (field === 'messages') {
          await handleMessagesEvent(value)
        } else if (field === 'message_template_status_update') {
          await handleTemplateStatusEvent(value)
        } else if (field === 'phone_number_quality_update') {
          await handleQualityUpdate(value)
        } else if (field === 'account_alerts') {
          console.log('[webhook] account_alert:', JSON.stringify(value))
        }
      } catch (err) {
        console.error(`[webhook][${field}]`, err.message)
      }
    }
  }
})

// ────────────────────────────────────────────────────────────────
// WEBHOOK HANDLER: messages
// Processes incoming messages and delivery status updates
// ────────────────────────────────────────────────────────────────
async function handleMessagesEvent(value) {
  const phoneNumberId = value.metadata?.phone_number_id
  const wabaId        = value.metadata?.display_phone_number

  // ── Delivery status updates ──
  for (const status of (value.statuses || [])) {
    // status: { id, status, timestamp, recipient_id, errors? }
    console.log(`[webhook] delivery status: ${status.id} → ${status.status}`)
    await callEdgeInternal('internalDeliveryWebhook', {
      id:           status.id,
      status:       status.status,
      timestamp:    status.timestamp,
      recipient_id: status.recipient_id,
      errors:       status.errors || [],
    })
  }

  // ── Incoming messages ──
  for (const msg of (value.messages || [])) {
    console.log(`[webhook] incoming message from ${msg.from}: type=${msg.type}`)
    await handleIncomingMessage(msg, phoneNumberId, value.contacts)
  }
}

// ────────────────────────────────────────────────────────────────
// INCOMING MESSAGE — log it and optionally trigger auto-reply
// ────────────────────────────────────────────────────────────────
async function handleIncomingMessage(msg, phoneNumberId, contacts) {
  // Find the WA account this message belongs to
  const accountRes = await sbFetch(
    `/wa_accounts?phone_number_id=eq.${phoneNumberId}&is_active=eq.true&limit=1`
  )
  const account = accountRes.data?.[0]
  if (!account) return

  const userId  = account.user_id
  const senderName = contacts?.[0]?.profile?.name || msg.from

  // Extract message text
  let messageText = ''
  if (msg.type === 'text') messageText = msg.text?.body || ''

  // Save to wb_inbox (if that table exists — optional)
  await sbFetch('/wb_inbox', {
    method: 'POST',
    body: JSON.stringify({
      user_id:         userId,
      wa_message_id:   msg.id,
      from_phone:      msg.from,
      from_name:       senderName,
      message_type:    msg.type,
      message_text:    messageText,
      message_raw:     JSON.stringify(msg),
      phone_number_id: phoneNumberId,
      timestamp:       new Date(parseInt(msg.timestamp) * 1000).toISOString(),
      is_read:         false,
      created_at:      new Date().toISOString(),
    }),
  }).catch(() => {}) // silently skip if table doesn't exist yet

  // Auto-reply if enabled
  const settingsRes = await sbFetch(
    `/wb_settings?user_id=eq.${userId}&limit=1`
  )
  const settings = settingsRes.data?.[0]

  if (settings?.auto_reply && messageText && account.access_token) {
    await sendAutoReply(
      msg.from,
      messageText,
      settings,
      account
    )
  }
}

// ────────────────────────────────────────────────────────────────
// AUTO-REPLY via Groq (if configured) or static reply
// ────────────────────────────────────────────────────────────────
async function sendAutoReply(toPhone, incomingText, settings, account) {
  let replyText = settings.auto_reply_prompt || 'Thank you for your message! We will get back to you soon.'

  // If Groq key is configured, generate a dynamic reply
  if (settings.groq_key) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${settings.groq_key}`,
        },
        body: JSON.stringify({
          model:       'llama3-8b-8192',
          max_tokens:  200,
          messages: [
            { role: 'system',    content: settings.auto_reply_prompt || 'You are a helpful business assistant. Reply briefly and professionally.' },
            { role: 'user',      content: incomingText },
          ],
        }),
      })
      const groqData = await groqRes.json()
      replyText = groqData.choices?.[0]?.message?.content || replyText
    } catch (err) {
      console.warn('[auto-reply] Groq error:', err.message)
    }
  }

  // Send text message back via Meta Cloud API
  await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${account.phone_number_id}/messages`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${account.access_token}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:                toPhone,
        type:              'text',
        text:              { body: replyText },
      }),
    }
  ).catch(err => console.warn('[auto-reply] send failed:', err.message))
}

// ────────────────────────────────────────────────────────────────
// WEBHOOK HANDLER: message_template_status_update
// Meta fires this when a template is APPROVED, REJECTED, PAUSED etc.
// We forward to the edge function which updates wb_templates.
// ────────────────────────────────────────────────────────────────
async function handleTemplateStatusEvent(value) {
  console.log('[webhook] template status update:', JSON.stringify(value))
  await callEdgeInternal('internalTemplateWebhook', value)
}

// ────────────────────────────────────────────────────────────────
// WEBHOOK HANDLER: phone_number_quality_update
// Updates quality_rating in wa_accounts
// ────────────────────────────────────────────────────────────────
async function handleQualityUpdate(value) {
  const { display_phone_number, current_limit, event } = value
  console.log(`[webhook] quality update for ${display_phone_number}: ${event}`)

  if (display_phone_number) {
    await sbFetch(
      `/wa_accounts?phone_number=eq.${encodeURIComponent(display_phone_number)}`,
      {
        method:  'PATCH',
        body:    JSON.stringify({
          quality_rating: event || 'UNKNOWN',
          updated_at:     new Date().toISOString(),
        }),
      }
    )
  }
}

// ================================================================
// CAMPAIGN QUEUE WORKER
// Runs every WORKER_POLL_MS ms.
// Picks one pending queue item, sends the message, marks done.
// Respects per-user sending limits from wb_settings.
// ================================================================
let workerRunning = false
let workerBusy    = false  // prevent overlapping ticks

async function campaignWorkerTick() {
  if (workerBusy) return
  workerBusy = true

  try {
    // Fetch one pending queue item (oldest first)
    // Using PATCH with Prefer: return=representation to atomically claim it
    const claimRes = await sbFetch(
      `/wb_campaign_queue?status=eq.pending&order=created_at.asc&limit=${MSG_BATCH_SIZE}`,
      {
        method:  'GET',
        headers: { 'Prefer': '' },
      }
    )

    const items = claimRes.data
    if (!Array.isArray(items) || items.length === 0) {
      workerBusy = false
      return
    }

    for (const item of items) {
      await processQueueItem(item)
      // Delay between messages (anti-spam)
      await randomDelay(MSG_MIN_DELAY_MS, MSG_MAX_DELAY_MS)
    }

  } catch (err) {
    console.error('[worker] tick error:', err.message)
  }

  workerBusy = false
}

async function processQueueItem(item) {
  const { id: queueId, campaign_id, user_id, phone, contact_name } = item

  // Mark as processing (atomic — prevents double-send if two workers run)
  const claimRes = await sbFetch(
    `/wb_campaign_queue?id=eq.${queueId}&status=eq.pending`,
    {
      method:  'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body:    JSON.stringify({ status: 'processing', updated_at: new Date().toISOString() }),
    }
  )

  // If no rows updated, another worker got it first — skip
  if (!claimRes.data?.length) return

  try {
    // Get campaign + template details
    const campRes = await sbFetch(
      `/wb_campaigns?id=eq.${campaign_id}&select=*,wb_templates(*)&limit=1`
    )
    const campaign = campRes.data?.[0]

    if (!campaign || campaign.status === 'paused') {
      // Campaign was paused — revert this item to paused
      await sbFetch(`/wb_campaign_queue?id=eq.${queueId}`, {
        method: 'PATCH',
        body:   JSON.stringify({ status: 'paused' }),
      })
      return
    }

    if (campaign.status !== 'running') {
      // Campaign cancelled or completed — mark item failed
      await sbFetch(`/wb_campaign_queue?id=eq.${queueId}`, {
        method: 'PATCH',
        body:   JSON.stringify({ status: 'failed' }),
      })
      return
    }

    const tpl         = campaign.wb_templates
    const placeholders = tpl?.placeholders || []

    // Check per-user sending limits
    const limitOk = await checkSendingLimits(user_id)
    if (!limitOk) {
      // Revert to pending — will retry on next tick
      await sbFetch(`/wb_campaign_queue?id=eq.${queueId}`, {
        method: 'PATCH',
        body:   JSON.stringify({ status: 'pending' }),
      })
      console.log(`[worker] rate limit hit for user ${user_id} — requeuing`)
      return
    }

    // Get contact details for placeholder mapping
    const contactRes = await sbFetch(
      `/wb_contacts?id=eq.${item.contact_id}&limit=1`
    )
    const contact = contactRes.data?.[0] || { name: contact_name, phone }

    // Build ordered placeholder values
    const orderedPositions = placeholders
      .slice()
      .sort((a, b) => a.position - b.position)

    const placeholderValues = orderedPositions.map(ph => {
      const mappedField = campaign.placeholder_mapping?.[`{{${ph.position}}}`]
      if (mappedField === 'name')    return contact.name   || ''
      if (mappedField === 'phone')   return contact.phone  || ''
      if (mappedField === 'message') return contact.message || ''
      if (mappedField && mappedField !== 'custom') return contact[mappedField] || ''
      // Custom static value stored directly in mapping
      const customVal = campaign.placeholder_mapping?.[`custom_${ph.position}`]
      if (customVal) return customVal
      // Fallback to sample
      return ph.sample || ''
    })

    // Call edge function to send (handles credit deduction + logging)
    const sendResult = await callEdgeInternal('sendTemplateMessage', {
      phone,
      template_name:      tpl.name,
      language:           tpl.language || 'en_US',
      placeholder_values: placeholderValues,
      header_type:        tpl.header_type || 'NONE',
      header_media_url:   tpl.header_media_url || null,
      campaign_id,
      contact_name:       contact.name || '',
    })

    if (sendResult.success) {
      // Mark queue item sent
      await sbFetch(`/wb_campaign_queue?id=eq.${queueId}`, {
        method: 'PATCH',
        body:   JSON.stringify({
          status:     'sent',
          sent_at:    new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      })

      // Track hourly/daily send count
      await incrementSendCount(user_id)

    } else {
      // Mark failed
      await sbFetch(`/wb_campaign_queue?id=eq.${queueId}`, {
        method: 'PATCH',
        body:   JSON.stringify({
          status:       'failed',
          error_reason: sendResult.message || 'Unknown error',
          updated_at:   new Date().toISOString(),
        }),
      })

      // If out of credits — pause the entire campaign
      if (sendResult.out_of_credits) {
        await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
          method: 'PATCH',
          body:   JSON.stringify({
            status:     'paused',
            updated_at: new Date().toISOString(),
          }),
        })
        // Revert all remaining pending items to paused
        await sbFetch(
          `/wb_campaign_queue?campaign_id=eq.${campaign_id}&status=eq.pending`,
          {
            method: 'PATCH',
            body:   JSON.stringify({ status: 'paused' }),
          }
        )
        console.log(`[worker] campaign ${campaign_id} paused — out of credits`)
      }
    }

    // Check if all queue items for this campaign are done
    await checkCampaignCompletion(campaign_id)

  } catch (err) {
    console.error(`[worker] error processing queue item ${queueId}:`, err.message)
    // Revert to pending so it retries
    await sbFetch(`/wb_campaign_queue?id=eq.${queueId}`, {
      method: 'PATCH',
      body:   JSON.stringify({ status: 'pending' }),
    }).catch(() => {})
  }
}

// ────────────────────────────────────────────────────────────────
// Check if user has hit their hourly/daily send limit
// Limits stored in wb_settings: hour_limit, day_limit
// Send counts tracked in wb_send_counts (simple rolling window)
// ────────────────────────────────────────────────────────────────

// In-memory send count cache (resets on server restart — that's fine)
const sendCounts = {}  // { user_id: { hour: N, day: N, hourTs: Date, dayTs: Date } }

async function checkSendingLimits(userId) {
  // Get user settings
  const settingsRes = await sbFetch(`/wb_settings?user_id=eq.${userId}&limit=1`)
  const settings    = settingsRes.data?.[0] || {}
  const hourLimit   = settings.hour_limit || 0   // 0 = unlimited
  const dayLimit    = settings.day_limit  || 0

  if (!sendCounts[userId]) {
    sendCounts[userId] = { hour: 0, day: 0, hourTs: Date.now(), dayTs: Date.now() }
  }

  const counts = sendCounts[userId]
  const now    = Date.now()

  // Reset hourly counter after 60 minutes
  if (now - counts.hourTs > 60 * 60 * 1000) {
    counts.hour   = 0
    counts.hourTs = now
  }
  // Reset daily counter after 24 hours
  if (now - counts.dayTs > 24 * 60 * 60 * 1000) {
    counts.day   = 0
    counts.dayTs = now
  }

  if (hourLimit > 0 && counts.hour >= hourLimit) return false
  if (dayLimit  > 0 && counts.day  >= dayLimit)  return false
  return true
}

async function incrementSendCount(userId) {
  if (!sendCounts[userId]) {
    sendCounts[userId] = { hour: 0, day: 0, hourTs: Date.now(), dayTs: Date.now() }
  }
  sendCounts[userId].hour++
  sendCounts[userId].day++
}

// ────────────────────────────────────────────────────────────────
// Check if all queue items for a campaign are done
// and mark the campaign completed if so
// ────────────────────────────────────────────────────────────────
async function checkCampaignCompletion(campaignId) {
  const pendingRes = await sbFetch(
    `/wb_campaign_queue?campaign_id=eq.${campaignId}&status=in.(pending,processing)&limit=1`,
    { headers: { 'Prefer': '' } }
  )

  const hasPending = pendingRes.data?.length > 0

  if (!hasPending) {
    // Check campaign isn't already paused
    const campRes = await sbFetch(`/wb_campaigns?id=eq.${campaignId}&limit=1`)
    const camp    = campRes.data?.[0]
    if (camp && camp.status === 'running') {
      await sbFetch(`/wb_campaigns?id=eq.${campaignId}`, {
        method: 'PATCH',
        body:   JSON.stringify({
          status:       'completed',
          completed_at: new Date().toISOString(),
          updated_at:   new Date().toISOString(),
        }),
      })
      console.log(`[worker] campaign ${campaignId} completed`)
    }
  }
}

// ================================================================
// START CAMPAIGN WORKER
// ================================================================
function startCampaignWorker() {
  workerRunning = true
  console.log(`[worker] Campaign queue worker started (poll every ${WORKER_POLL_MS}ms)`)
  setInterval(campaignWorkerTick, WORKER_POLL_MS)
}

// ================================================================
// SELF-PINGER (keeps Render free tier awake)
// ================================================================
const PING_INTERVAL = 14 * 60 * 1000  // 14 minutes

function startPinger() {
  setInterval(async () => {
    try {
      const r = await fetch(`${SELF_URL}/health`)
      console.log(`[pinger] ${new Date().toISOString()} — ${r.status}`)
    } catch (err) {
      console.error('[pinger] failed:', err.message)
    }
  }, PING_INTERVAL)
}

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log(`WaBlast server running on ${SELF_URL}`)
  startPinger()
  startCampaignWorker()
})

// ================================================================
// REQUIRED ENV VARIABLES
// ================================================================
// PORT                      — set by Render automatically
// RENDER_EXTERNAL_URL       — set by Render automatically (e.g. https://wablast.onrender.com)
// META_APP_ID               — your Meta App ID
// META_APP_SECRET           — your Meta App Secret
// META_WEBHOOK_VERIFY_TOKEN — any random string, must match what you set in Meta App Dashboard
// SUPABASE_URL              — your Supabase project URL
// SUPABASE_SERVICE_KEY      — Supabase service role key (not anon key)
//
// REQUIRED SUPABASE TABLE: wb_campaign_queue
//   id            uuid primary key default gen_random_uuid()
//   campaign_id   uuid references wb_campaigns(id)
//   user_id       uuid references auth.users(id)
//   contact_id    uuid references wb_contacts(id)
//   phone         text not null
//   contact_name  text
//   status        text default 'pending'  -- pending|processing|sent|failed|paused
//   error_reason  text
//   sent_at       timestamptz
//   created_at    timestamptz default now()
//   updated_at    timestamptz default now()
//
// REQUIRED SUPABASE TABLE: wb_inbox (optional — for incoming messages)
//   id              uuid primary key default gen_random_uuid()
//   user_id         uuid
//   wa_message_id   text
//   from_phone      text
//   from_name       text
//   message_type    text
//   message_text    text
//   message_raw     jsonb
//   phone_number_id text
//   timestamp       timestamptz
//   is_read         boolean default false
//   created_at      timestamptz default now()
//
// REQUIRED SUPABASE COLUMN: wb_settings.groq_key text
// REQUIRED SUPABASE COLUMN: wb_campaign_logs.delivery_status text
// REQUIRED SUPABASE COLUMN: wb_campaign_logs.delivered_at timestamptz
// REQUIRED SUPABASE COLUMN: wb_campaign_logs.read_at timestamptz
// REQUIRED SUPABASE COLUMN: wb_campaign_logs.wa_message_id text
//
// META APP DASHBOARD SETUP:
// 1. Add webhook URL: https://your-render-url.onrender.com/webhook
// 2. Set verify token to match META_WEBHOOK_VERIFY_TOKEN env var
// 3. Subscribe to: messages, message_template_status_update,
//                  phone_number_quality_update, account_alerts
// 4. Add your Render domain to Meta App's Valid OAuth Redirect URIs:
//    https://your-render-url.onrender.com/wa-callback
