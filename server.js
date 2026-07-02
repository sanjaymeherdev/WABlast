// server.js — WaBlast Express Server (Queue-based v2) — FIXED
// Handles: static files, WA manual connect (System User token), webhooks, queue processing via Edge
// ✅ Auth-verified manual connect, safe insert-before-deactivate ordering, full webhook logging

require('dotenv').config()
const express = require('express')
const fetch = require('node-fetch')
const crypto = require('crypto')
const path = require('path')
const { encryptToken, decryptToken } = require('./crypto-utils')

const app = express()
const PORT = process.env.PORT || 3000

// ================================================================
// ENV
// ================================================================
const SELF_URL            = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`
const META_VERIFY_TOKEN   = process.env.META_WEBHOOK_VERIFY_TOKEN
const META_APP_SECRET     = process.env.META_APP_SECRET
const META_API_VERSION    = 'v20.0'
const SUPABASE_URL        = process.env.SUPABASE_URL
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY   // service role — server-side only
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY      // used only to verify user JWTs
const EDGE_FN_URL         = `${SUPABASE_URL}/functions/v1/wablast`

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

// ✅ Verify the caller's Supabase session token and return their user id.
// Returns null if missing/invalid — callers must reject the request in that case.
async function verifySupabaseUser(req) {
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return null

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey':         SUPABASE_ANON_KEY,
      },
    })
    if (!res.ok) return null
    const user = await res.json()
    return user?.id ? user : null
  } catch (_) {
    return null
  }
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
// WA MANUAL CONNECT — System User Token flow (no embedded signup)
// ================================================================

// Step 1: verify token + WABA, return list of phone numbers to pick from
// (no user identity needed yet — just checking the token/WABA are valid)
app.post('/api/wa/manual/verify', async (req, res) => {
  const { waba_id, access_token } = req.body
  if (!waba_id || !access_token) {
    return res.status(400).json({ error: 'waba_id and access_token are required' })
  }

  try {
    const wabaRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}?fields=id,name,timezone_id`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    )
    const wabaData = await wabaRes.json()
    if (wabaData.error) {
      return res.status(400).json({ error: 'Invalid token or WABA ID: ' + wabaData.error.message })
    }

    const phoneRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/phone_numbers` +
      `?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    )
    const phoneData = await phoneRes.json()
    if (phoneData.error) {
      return res.status(400).json({ error: 'Could not list phone numbers: ' + phoneData.error.message })
    }

    const numbers = (phoneData.data || []).map(p => ({
      phone_number_id: p.id,
      phone_number:    p.display_phone_number,
      display_name:    p.verified_name,
      quality_rating:  p.quality_rating || 'UNKNOWN',
      verified:        p.code_verification_status === 'VERIFIED',
    }))

    if (!numbers.length) {
      return res.status(400).json({ error: 'No phone numbers found under this WABA. Add one in Meta Business Manager first.' })
    }

    res.json({ success: true, waba_name: wabaData.name, numbers })
  } catch (err) {
    console.error('[wa-manual-verify] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Step 2: save the chosen number
// ✅ Requires a valid Supabase session token — user_id comes from the verified
//    session, never from the request body, so no one can attach a number to
//    another user's account.
app.post('/api/wa/manual/save', async (req, res) => {
  const user = await verifySupabaseUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in again.' })
  const user_id = user.id

  const { waba_id, phone_number_id, access_token } = req.body
  if (!waba_id || !phone_number_id || !access_token) {
    return res.status(400).json({ error: 'waba_id, phone_number_id, and access_token are all required' })
  }

  try {
    // Re-verify ownership right before saving (avoid stale/tampered client data)
    const phoneRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}` +
      `?fields=id,display_phone_number,verified_name,quality_rating`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    )
    const phoneData = await phoneRes.json()
    if (phoneData.error) {
      return res.status(400).json({ error: 'Invalid token or phone number: ' + phoneData.error.message })
    }

    const wabaCheckRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/phone_numbers`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    )
    const wabaCheckData = await wabaCheckRes.json()
    const belongsToWaba = wabaCheckData.data?.some(p => p.id === phone_number_id)
    if (!belongsToWaba) {
      return res.status(400).json({ error: 'This phone number does not belong to the given WABA ID' })
    }

    // Subscribe app to this WABA's webhooks (delivery statuses, incoming msgs, template updates)
    const subRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/subscribed_apps`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${access_token}` } }
    )
    const subData = await subRes.json()
    if (subData.error) {
      console.warn('[wa-manual-save] subscribe warning:', subData.error.message)
      // don't hard-fail — number can still send, webhooks just won't arrive until fixed
    }

    // ✅ Insert the new row FIRST — if this fails, the user's previous active
    //    number (if any) is untouched and nothing needs rolling back.
    const insertRes = await sbFetch('/wa_accounts', {
      method: 'POST',
      body: JSON.stringify({
        user_id,
        waba_id,
        phone_number_id,
        phone_number:   phoneData.display_phone_number,
        display_name:   phoneData.verified_name,
        access_token: encryptToken(access_token), // encrypted at rest (AES-256-GCM)
        quality_rating: phoneData.quality_rating || 'GREEN',
        is_active:      true,
        messages_sent_today: 0,
        last_reset_date: new Date().toISOString().split('T')[0],
        created_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
    })

    if (!insertRes.ok) return res.status(500).json({ error: 'Failed to save account' })
    const newAccountId = insertRes.data?.[0]?.id

    // ✅ Now deactivate any OTHER active number for this user, excluding the one
    //    we just created — this only runs after the new row is confirmed saved.
    if (newAccountId) {
      await sbFetch(
        `/wa_accounts?user_id=eq.${user_id}&is_active=eq.true&id=neq.${newAccountId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
        }
      )
    }

    res.json({
      success: true,
      phone_number: phoneData.display_phone_number,
      display_name: phoneData.verified_name,
      webhook_subscribed: !subData.error,
    })
  } catch (err) {
    console.error('[wa-manual-save] error:', err.message)
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
