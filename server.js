// server.js — WaBlast Express Server
// Handles: static files, WA Embedded Signup OAuth, Meta webhooks,
//          campaign send loop, self-pinger

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
const META_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN
const META_API_VERSION  = 'v20.0'
const SUPABASE_URL      = process.env.SUPABASE_URL
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY
const EDGE_FN_URL       = `${SUPABASE_URL}/functions/v1/wablast`
const META_CONFIG_ID    = process.env.META_CONFIG_ID

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf }
}))
app.use(express.static(path.join(__dirname, 'public')))

// ================================================================
// IN-MEMORY CAMPAIGN STORE
// ================================================================
const activeCampaigns = {}

// ================================================================
// HELPERS
// ================================================================
async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`
  const res = await fetch(url, {
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

async function metaFetch(path, method = 'GET', body, token) {
  const url = path.startsWith('http')
    ? path
    : `https://graph.facebook.com/${META_API_VERSION}${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

function verifyMetaSignature(req) {
  const sigHeader = req.headers['x-hub-signature-256'] || ''
  if (!sigHeader) return false
  const expected = 'sha256=' +
    crypto.createHmac('sha256', META_APP_SECRET)
          .update(req.rawBody)
          .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))
  } catch (_) { return false }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomDelay(min, max) {
  return delay(Math.floor(Math.random() * (max - min + 1)) + min)
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    active_campaigns: Object.keys(activeCampaigns).length,
  })
})

// ================================================================
// SERVE APP
// ================================================================
app.get('/',        (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')))
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')))

// ================================================================
// WA EMBEDDED SIGNUP — STEP 1
// ================================================================
app.get('/wa-connect', (_req, res) => {
  if (!META_APP_ID) return res.status(500).send('META_APP_ID not configured')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Connect WhatsApp</title>
  <style>
    body { font-family:sans-serif; background:#0a0c12; color:#edf2f9; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; margin:0; gap:16px; }
    .logo { font-size:32px; }
    p { color:#8e9cb0; font-size:14px; text-align:center; }
    button { background:#25d366; color:#000; border:none; padding:14px 28px; border-radius:12px; font-size:15px; font-weight:700; cursor:pointer; }
    button:hover { background:#20bf5a; }
    #status { font-size:13px; color:#8e9cb0; min-height:20px; }
  </style>
</head>
<body>
  <div class="logo">💬</div>
  <h2 style="margin:0">Connect WhatsApp Number</h2>
  <p>Click below to connect your WhatsApp Business number via Meta.</p>
  <button id="connectBtn" onclick="launchSignup()">Connect via Meta</button>
  <div id="status"></div>
  <script>
    window.fbAsyncInit = function() {
      FB.init({ appId:'${META_APP_ID}', cookie:true, xfbml:true, version:'${META_API_VERSION}' })
    };
    (function(d,s,id){ var js,fjs=d.getElementsByTagName(s)[0]; if(d.getElementById(id))return; js=d.createElement(s); js.id=id; js.src='https://connect.facebook.net/en_US/sdk.js'; fjs.parentNode.insertBefore(js,fjs); }(document,'script','facebook-jssdk'))
    function setStatus(msg){ document.getElementById('status').textContent=msg }
    function launchSignup() {
      setStatus('Opening Meta login...')
      document.getElementById('connectBtn').disabled = true
      FB.login(function(response) {
        if (response.authResponse) {
          var code = response.authResponse.code
          setStatus('Connected! Saving your number...')
          if (window.opener) window.opener.postMessage({ type:'WA_CODE', code:code }, '*')
          setStatus('Done! You can close this window.')
          setTimeout(function(){ window.close() }, 1500)
        } else {
          setStatus('Connection cancelled or failed. Please try again.')
          document.getElementById('connectBtn').disabled = false
        }
      }, {
        config_id: '${META_CONFIG_ID}',
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup:{}, featureType:'', sessionInfoVersion:'3' }
      })
    }
  </script>
</body>
</html>`
  res.send(html)
})

// ================================================================
// WA EMBEDDED SIGNUP — STEP 2 (OAuth callback)
// ================================================================
app.get('/wa-callback', (req, res) => {
  const code  = req.query.code  || ''
  const error = req.query.error || ''
  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0a0c12;color:#edf2f9;text-align:center;padding-top:60px;">
<script>
  var code=${JSON.stringify(code)}, error=${JSON.stringify(error)}
  if(error){ window.opener&&window.opener.postMessage({type:'WA_ERROR',error:error},'*') }
  else if(code){ window.opener&&window.opener.postMessage({type:'WA_CODE',code:code},'*') }
  setTimeout(function(){ window.close() }, 800)
<\/script>
<p>Connecting WhatsApp… closing window.</p>
</body></html>`
  res.send(html)
})

// ================================================================
// WA EMBEDDED SIGNUP — STEP 3
// ================================================================
app.post('/api/wa/connect', async (req, res) => {
  const { code, user_id } = req.body
  if (!code || !user_id)
    return res.status(400).json({ error: 'Missing code or user_id' })

  try {
    const tokenRes = await metaFetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token` +
      `?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${encodeURIComponent(code)}`
    )
    if (!tokenRes.ok || tokenRes.data.error)
      return res.status(400).json({ error: tokenRes.data.error?.message || 'Token exchange failed' })

    const accessToken = tokenRes.data.access_token

    let wabaId = null
    const wabaRes = await metaFetch('/me/whatsapp_business_accounts?fields=id,name', 'GET', undefined, accessToken)

    if (wabaRes.ok && wabaRes.data.data?.length) {
      wabaId = wabaRes.data.data[0].id
    } else {
      const bizRes = await metaFetch('/me/businesses?fields=id,name', 'GET', undefined, accessToken)
      if (!bizRes.ok || !bizRes.data.data?.length)
        return res.status(400).json({ error: 'No WhatsApp Business Account found.' })

      for (const biz of bizRes.data.data) {
        const wabaList = await metaFetch(
          `/${biz.id}/owned_whatsapp_business_accounts?fields=id,name`,
          'GET', undefined, accessToken
        )
        if (wabaList.ok && wabaList.data.data?.length) {
          wabaId = wabaList.data.data[0].id
          break
        }
      }
      if (!wabaId)
        return res.status(400).json({ error: 'No WABA found under your business.' })
    }

    const phoneRes = await metaFetch(
      `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status`,
      'GET', undefined, accessToken
    )
    if (!phoneRes.ok || !phoneRes.data.data?.length)
      return res.status(400).json({ error: 'No phone numbers found for this WABA.' })

    const phone = phoneRes.data.data[0]

    await metaFetch(`/${wabaId}/subscribed_apps`, 'POST', undefined, accessToken)

    const insertRes = await sbFetch('/wa_accounts', {
      method:  'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
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
        updated_at:      new Date().toISOString(),
        created_at:      new Date().toISOString(),
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
// WA ACCOUNTS — LIST
// ================================================================
app.get('/api/wa/accounts', async (req, res) => {
  const { user_id } = req.query
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' })
  try {
    const r = await sbFetch(`/wa_accounts?user_id=eq.${user_id}&is_active=eq.true&order=created_at.desc`)
    res.json(r.data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ================================================================
// CAMPAIGN — START
// All checks upfront. Send loop only fires the payload — nothing else.
// Success/failure is tracked via webhook only.
// ================================================================
app.post('/api/campaign/start', async (req, res) => {
  const { campaign_id, user_id } = req.body
  if (!campaign_id || !user_id)
    return res.status(400).json({ error: 'campaign_id and user_id required' })

  if (activeCampaigns[campaign_id]?.status === 'running')
    return res.status(400).json({ error: 'Campaign already running' })

  try {
    // ── 1. Load campaign ──────────────────────────────────────
    const campRes = await sbFetch(`/wb_campaigns?id=eq.${campaign_id}&user_id=eq.${user_id}&limit=1`)
    const campaign = campRes.data?.[0]
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

    // ── 2. Load template ──────────────────────────────────────
    const tplRes = await sbFetch(`/wb_templates?id=eq.${campaign.template_id}&limit=1`)
    const template = tplRes.data?.[0]
    if (!template)                   return res.status(404).json({ error: 'Template not found' })
    if (template.status !== 'APPROVED') return res.status(400).json({ error: 'Template is not APPROVED' })

    // ── 3. Load WA account (fresh token every start) ──────────
    const accountRes = await sbFetch(`/wa_accounts?user_id=eq.${user_id}&is_active=eq.true&order=created_at.desc&limit=1`)
    const account = accountRes.data?.[0]
    if (!account) return res.status(400).json({ error: 'No WhatsApp account connected' })
    if (account.quality_rating === 'RED')
      return res.status(400).json({ error: 'Cannot send — your WhatsApp number quality rating is RED.' })

    // ── 4. Load contacts ──────────────────────────────────────
    let contactQuery = `/wb_contacts?user_id=eq.${user_id}&select=*`
    if (campaign.group_name && campaign.group_name.trim() !== '') {
      contactQuery += `&group_name=eq.${encodeURIComponent(campaign.group_name)}`
    }
    const contactsRes = await sbFetch(contactQuery)
    let contacts = contactsRes.data || []

    if (!contacts.length) {
      const groupInfo = campaign.group_name ? ` in group "${campaign.group_name}"` : ''
      return res.status(400).json({ error: `No contacts found${groupInfo}.` })
    }

    // ── 5. Remove blocklisted numbers ─────────────────────────
    const blocklistRes = await sbFetch(`/wb_blocklist?user_id=eq.${user_id}&select=phone`)
    const blockedPhones = new Set((blocklistRes.data || []).map(b => b.phone))
    contacts = contacts.filter(c => !blockedPhones.has(c.phone))

    if (!contacts.length)
      return res.status(400).json({ error: 'All contacts are blocklisted.' })

    // ── 6. Check credits (must cover ALL contacts) ────────────
    const profileRes = await sbFetch(`/wb_profiles?id=eq.${user_id}&limit=1`)
    const profile = profileRes.data?.[0]
    if (!profile)
      return res.status(400).json({ error: 'User profile not found.' })
    if (profile.credits < contacts.length)
      return res.status(400).json({
        error: `Insufficient credits. Need ${contacts.length}, have ${profile.credits}.`
      })

    // ── 7. Check daily sending limit ──────────────────────────
    const settingsRes = await sbFetch(`/wb_settings?user_id=eq.${user_id}&limit=1`)
    const settings = settingsRes.data?.[0] || {}
    const dailyLimit = settings.day_limit || 0

    // Reset counter if it's a new day
    const today = new Date().toISOString().split('T')[0]
    let sentToday = account.messages_sent_today || 0
    if (account.last_reset_date !== today) sentToday = 0

    if (dailyLimit > 0 && sentToday >= dailyLimit)
      return res.status(400).json({
        error: `Daily limit reached (${sentToday}/${dailyLimit}). Try again tomorrow.`
      })

    // ── 8. Deduct ALL credits upfront atomically ──────────────
    const newCredits = profile.credits - contacts.length
    const deductRes = await sbFetch(`/wb_profiles?id=eq.${user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ credits: newCredits, updated_at: new Date().toISOString() }),
    })
    if (!deductRes.ok)
      return res.status(500).json({ error: 'Failed to deduct credits. Please try again.' })

    // Log the credit deduction
    await sbFetch('/wb_credit_transactions', {
      method: 'POST',
      body: JSON.stringify({
        user_id,
        type:           'deduct',
        amount:         -contacts.length,
        balance_before: profile.credits,
        balance_after:  newCredits,
        description:    `Campaign: ${campaign.name}`,
        ref_id:         campaign_id,
        created_at:     new Date().toISOString(),
      }),
    })

    // ── 9. Build send config ──────────────────────────────────
    const minGap = (settings.min_gap || 5) * 1000
    const maxGap = (settings.max_gap || 15) * 1000

    // Resume support: if was paused, continue from where it left off
    const existing = activeCampaigns[campaign_id]
    const startIndex = (existing?.status === 'paused') ? (existing.currentIndex || 0) : 0

    activeCampaigns[campaign_id] = {
      status:       'running',
      user_id,
      campaign,
      template,
      account,      // fresh token captured here
      contacts,
      settings:     { minGap, maxGap, dailyLimit, sentToday },
      currentIndex: startIndex,
      sent:         existing?.sent   || 0,
      failed:       existing?.failed || 0,
      log:          existing?.log    || [],
    }

    // Update campaign status in DB — reset counts so stale data never shows
    await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status:         'running',
        total_contacts: contacts.length,
        sent_count:     0,
        failed_count:   0,
        started_at:     new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      }),
    })

    // Start the send loop (non-blocking)
    runSendLoop(campaign_id)

    res.json({ success: true, total: contacts.length, message: `Campaign started — ${contacts.length} contacts queued` })

  } catch (err) {
    console.error('[/api/campaign/start]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ================================================================
// CAMPAIGN — PAUSE
// ================================================================
app.post('/api/campaign/pause', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })

  const job = activeCampaigns[campaign_id]
  if (!job) return res.status(404).json({ error: 'Campaign not active' })

  job.status = 'paused'
  await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'paused', updated_at: new Date().toISOString() }),
  })

  res.json({ success: true, message: 'Campaign paused' })
})

// ================================================================
// CAMPAIGN — STOP
// ================================================================
app.post('/api/campaign/stop', async (req, res) => {
  const { campaign_id } = req.body
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' })

  const job = activeCampaigns[campaign_id]
  if (job) {
    // Refund unused credits
    const remaining = job.contacts.length - job.currentIndex
    if (remaining > 0) {
      const profileRes = await sbFetch(`/wb_profiles?id=eq.${job.user_id}&limit=1`)
      const profile = profileRes.data?.[0]
      if (profile) {
        const refunded = profile.credits + remaining
        await sbFetch(`/wb_profiles?id=eq.${job.user_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ credits: refunded, updated_at: new Date().toISOString() }),
        })
        await sbFetch('/wb_credit_transactions', {
          method: 'POST',
          body: JSON.stringify({
            user_id:        job.user_id,
            type:           'refund',
            amount:         remaining,
            balance_before: profile.credits,
            balance_after:  refunded,
            description:    `Campaign stopped early: ${job.campaign.name}`,
            ref_id:         campaign_id,
            created_at:     new Date().toISOString(),
          }),
        })
      }
    }
    job.status = 'stopped'
  }

  await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'draft', updated_at: new Date().toISOString() }),
  })

  delete activeCampaigns[campaign_id]
  res.json({ success: true, message: 'Campaign stopped' })
})

// ================================================================
// CAMPAIGN — STATUS
// ================================================================
app.get('/api/campaign/status/:campaign_id', async (req, res) => {
  const { campaign_id } = req.params
  const job = activeCampaigns[campaign_id]

  if (!job) {
    const dbRes = await sbFetch(`/wb_campaigns?id=eq.${campaign_id}&limit=1`)
    const dbCamp = dbRes.data?.[0]
    if (dbCamp) {
      return res.json({
        status:  dbCamp.status,
        sent:    dbCamp.sent_count    || 0,
        failed:  dbCamp.failed_count  || 0,
        pending: Math.max(0, (dbCamp.total_contacts || 0) - (dbCamp.sent_count || 0) - (dbCamp.failed_count || 0)),
        total:   dbCamp.total_contacts || 0,
        log:     [],
      })
    }
    return res.json({ status: 'idle', sent: 0, failed: 0, pending: 0, total: 0, log: [] })
  }

  const total   = job.contacts.length
  const pending = Math.max(0, total - job.currentIndex)

  res.json({
    status:  job.status,
    sent:    job.sent,
    failed:  job.failed,
    pending,
    total,
    log:     job.log.slice(-50),
  })
})

// ================================================================
// SEND LOOP — Simplified
// Only job: build the payload and POST it to Meta.
// Success/failure tracking is done by the webhook handler.
// In-memory log is for the live UI only.
// ================================================================
async function runSendLoop(campaign_id) {
  const job = activeCampaigns[campaign_id]
  if (!job) return

  const { template, account, contacts, settings } = job
  const placeholderMapping = job.campaign.placeholder_mapping || {}

  for (let i = job.currentIndex; i < contacts.length; i++) {
    // Check pause/stop on every iteration
    if (job.status !== 'running') {
      job.currentIndex = i
      return
    }

    job.currentIndex = i + 1
    const contact = contacts[i]

    // ── Build template components ──────────────────────────────
    const placeholders = (template.placeholders || []).slice().sort((a, b) => a.position - b.position)

    const bodyParams = placeholders.map(ph => {
      const field = placeholderMapping[`{{${ph.position}}}`]
      if (field === 'name')    return contact.name    || ''
      if (field === 'phone')   return contact.phone   || ''
      if (field === 'message') return contact.message || ''
      const customVal = placeholderMapping[`custom_${ph.position}`]
      return customVal || ph.sample || ''
    })

    const templateComponents = []

    // Header media (only for IMAGE / VIDEO / DOCUMENT)
    if (
      template.header_type &&
      template.header_type !== 'NONE' &&
      template.header_type !== 'TEXT' &&
      template.header_type !== 'LOCATION' &&
      template.header_media_url
    ) {
      const mediaKey = template.header_type === 'IMAGE'    ? 'image'
                     : template.header_type === 'VIDEO'    ? 'video'
                     : 'document'
      templateComponents.push({
        type: 'header',
        parameters: [{ type: mediaKey, [mediaKey]: { link: template.header_media_url } }],
      })
    }

    // Body params
    if (bodyParams.length > 0) {
      templateComponents.push({
        type: 'body',
        parameters: bodyParams.map(v => ({ type: 'text', text: String(v) })),
      })
    }

    // ── Build final payload ────────────────────────────────────
    const payload = {
      messaging_product: 'whatsapp',
      to:                contact.phone,
      type:              'template',
      template: {
        name:     template.name,
        language: { code: template.language || 'en_US' },
        ...(templateComponents.length > 0 ? { components: templateComponents } : {}),
      },
    }

    // ── Fire and log ───────────────────────────────────────────
    try {
      const sendRes = await metaFetch(
        `/${account.phone_number_id}/messages`,
        'POST',
        payload,
        account.access_token
      )

      if (sendRes.ok && sendRes.data?.messages?.[0]?.id) {
        const waMessageId = sendRes.data.messages[0].id
        job.sent++
        job.log.push({ time: new Date().toISOString(), name: contact.name, phone: contact.phone, status: 'sent', error: null })

        // Insert log row — delivery status will be updated by webhook
        await sbFetch('/wb_campaign_logs', {
          method: 'POST',
          body: JSON.stringify({
            campaign_id,
            phone:           contact.phone,
            contact_name:    contact.name || '',
            status:          'sent',
            delivery_status: 'sent',
            wa_message_id:   waMessageId,
            credits_deducted: 1,
            created_at:      new Date().toISOString(),
            sent_at:         new Date().toISOString(),
          }),
        })

        // Update daily counter on the account row
        await sbFetch(`/wa_accounts?id=eq.${account.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            messages_sent_today: (settings.sentToday || 0) + job.sent,
            last_reset_date:     new Date().toISOString().split('T')[0],
            updated_at:          new Date().toISOString(),
          }),
        })

      } else {
        // Meta rejected the message
        const errorMsg = sendRes.data?.error?.message || `Meta error code ${sendRes.status}`
        console.error(`[send] failed for ${contact.phone}: ${errorMsg}`)
        job.failed++
        job.log.push({ time: new Date().toISOString(), name: contact.name, phone: contact.phone, status: 'failed', error: errorMsg })

        await sbFetch('/wb_campaign_logs', {
          method: 'POST',
          body: JSON.stringify({
            campaign_id,
            phone:           contact.phone,
            contact_name:    contact.name || '',
            status:          'failed',
            delivery_status: 'failed',
            error_reason:    errorMsg,
            credits_deducted: 0,
            created_at:      new Date().toISOString(),
          }),
        })
      }
    } catch (err) {
      // Network / timeout error — log as failed, keep going
      console.error(`[send] exception for ${contact.phone}: ${err.message}`)
      job.failed++
      job.log.push({ time: new Date().toISOString(), name: contact.name, phone: contact.phone, status: 'failed', error: err.message })

      await sbFetch('/wb_campaign_logs', {
        method: 'POST',
        body: JSON.stringify({
          campaign_id,
          phone:           contact.phone,
          contact_name:    contact.name || '',
          status:          'failed',
          delivery_status: 'failed',
          error_reason:    err.message,
          credits_deducted: 0,
          created_at:      new Date().toISOString(),
        }),
      })
    }

    // Update campaign stats in DB every message
    await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        sent_count:   job.sent,
        failed_count: job.failed,
        updated_at:   new Date().toISOString(),
      }),
    })

    // Gap between messages (skip after last one)
    if (i < contacts.length - 1 && job.status === 'running') {
      await randomDelay(settings.minGap, settings.maxGap)
    }
  }

  // Loop finished naturally
  if (job.status === 'running') {
    job.status = 'completed'
    await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status:       'completed',
        completed_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      }),
    })
    console.log(`[campaign] ${campaign_id} completed — sent:${job.sent} failed:${job.failed}`)
  }
}

// ================================================================
// META WEBHOOK — VERIFICATION
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
// META WEBHOOK — EVENTS
// ================================================================
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200)

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
        if (field === 'messages')
          await handleMessagesEvent(value)
        else if (field === 'message_template_status_update')
          await handleTemplateStatusEvent(value)
        else if (field === 'phone_number_quality_update')
          await handleQualityUpdate(value)
      } catch (err) {
        console.error(`[webhook][${field}]`, err.message)
      }
    }
  }
})

// ── Delivery status updates from Meta ──────────────────────────
async function handleMessagesEvent(value) {
  const phoneNumberId = value.metadata?.phone_number_id

  // Update delivery status for sent messages (delivered / read / failed)
  for (const status of (value.statuses || [])) {
    console.log(`[webhook] delivery: ${status.id} → ${status.status}`)
    await callEdgeInternal('internalDeliveryWebhook', {
      id:           status.id,
      status:       status.status,
      timestamp:    status.timestamp,
      recipient_id: status.recipient_id,
      errors:       status.errors || [],
    })
  }

  // Handle incoming messages
  for (const msg of (value.messages || [])) {
    console.log(`[webhook] incoming from ${msg.from}: type=${msg.type}`)
    await handleIncomingMessage(msg, phoneNumberId, value.contacts)
  }
}

async function handleIncomingMessage(msg, phoneNumberId, contacts) {
  const accountRes = await sbFetch(`/wa_accounts?phone_number_id=eq.${phoneNumberId}&is_active=eq.true&limit=1`)
  const account = accountRes.data?.[0]
  if (!account) return

  const userId     = account.user_id
  const senderName = contacts?.[0]?.profile?.name || msg.from
  const messageText = msg.type === 'text' ? (msg.text?.body || '') : ''

  const settingsRes = await sbFetch(`/wb_settings?user_id=eq.${userId}&limit=1`)
  const settings = settingsRes.data?.[0]

  // Handle STOP / unsubscribe
  if (messageText && /^(stop|unsubscribe|end|stopall|quit|cancel)$/i.test(messageText.trim())) {
    await sbFetch('/wb_blocklist', {
      method: 'POST',
      body: JSON.stringify({
        user_id:             userId,
        phone:               msg.from,
        reason:              'STOP',
        source:              'incoming_message',
        original_message_id: msg.id,
        created_at:          new Date().toISOString(),
      }),
    })
    await sbFetch(`/wb_contacts?user_id=eq.${userId}&phone=eq.${msg.from}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() }),
    })
    console.log(`[STOP] ${msg.from} unsubscribed`)
    if (settings?.auto_reply && account.access_token)
      await sendAutoReply(msg.from, messageText, settings, account)
    return
  }

  // Save to inbox
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
  }).catch(() => {})

  // Auto-reply
  if (settings?.auto_reply && messageText && account.access_token)
    await sendAutoReply(msg.from, messageText, settings, account)
}

async function sendAutoReply(toPhone, incomingText, settings, account) {
  let replyText = settings.auto_reply_prompt || 'Thank you for your message! We will get back to you soon.'

  if (settings.groq_key) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.groq_key}` },
        body: JSON.stringify({
          model:      'llama3-8b-8192',
          max_tokens: 200,
          messages: [
            { role: 'system', content: settings.auto_reply_prompt || 'You are a helpful business assistant.' },
            { role: 'user',   content: incomingText },
          ],
        }),
      })
      const groqData = await groqRes.json()
      replyText = groqData.choices?.[0]?.message?.content || replyText
    } catch (err) {
      console.warn('[auto-reply] Groq error:', err.message)
    }
  }

  await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${account.phone_number_id}/messages`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${account.access_token}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   toPhone,
        type: 'text',
        text: { body: replyText },
      }),
    }
  ).catch(err => console.warn('[auto-reply] send failed:', err.message))
}

async function handleTemplateStatusEvent(value) {
  console.log('[webhook] template status update:', JSON.stringify(value))
  await callEdgeInternal('internalTemplateWebhook', value)
}

async function handleQualityUpdate(value) {
  const { display_phone_number, event } = value
  console.log(`[webhook] quality update for ${display_phone_number}: ${event}`)
  if (display_phone_number) {
    await sbFetch(`/wa_accounts?phone_number=eq.${encodeURIComponent(display_phone_number)}`, {
      method: 'PATCH',
      body:   JSON.stringify({ quality_rating: event || 'UNKNOWN', updated_at: new Date().toISOString() }),
    })
  }
}

// ================================================================
// SELF-PINGER (keeps Render free tier alive)
// ================================================================
function startPinger() {
  setInterval(async () => {
    try {
      const r = await fetch(`${SELF_URL}/health`)
      console.log(`[pinger] ${new Date().toISOString()} — ${r.status}`)
    } catch (err) {
      console.error('[pinger] failed:', err.message)
    }
  }, 14 * 60 * 1000)
}

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`WaBlast server running on ${SELF_URL}`)
  startPinger()
})
