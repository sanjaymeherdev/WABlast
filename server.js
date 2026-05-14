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

async function incrementSentCount(accountId) {
  const accRes = await sbFetch(`/wa_accounts?id=eq.${accountId}&limit=1`)
  const account = accRes.data?.[0]
  if (!account) return
  
  const today = new Date().toISOString().split('T')[0]
  
  if (account.last_reset_date !== today) {
    await sbFetch(`/wa_accounts?id=eq.${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        messages_sent_today: 1,
        last_reset_date: today,
        updated_at: new Date().toISOString()
      }),
    })
    return
  }
  
  await sbFetch(`/wa_accounts?id=eq.${accountId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      messages_sent_today: (account.messages_sent_today || 0) + 1,
      updated_at: new Date().toISOString()
    }),
  })
}

async function handleStopCommand(userId, phone, contactName, messageId) {
  await sbFetch('/wb_blocklist', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      phone: phone,
      reason: 'STOP',
      source: 'incoming_message',
      original_message_id: messageId,
      created_at: new Date().toISOString()
    }),
  })
  
  await sbFetch(`/wb_contacts?user_id=eq.${userId}&phone=eq.${phone}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'unsubscribed',
      unsubscribed_at: new Date().toISOString()
    }),
  })
  
  console.log(`[STOP] ${phone} unsubscribed`)
}

async function updateCampaignStats(campaign_id, sent_count, failed_count) {
  await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ 
      sent_count: sent_count,
      failed_count: failed_count,
      updated_at: new Date().toISOString()
    }),
  })
}

async function insertCampaignLog(campaign_id, phone, contact_name, status, error_reason, wa_message_id = null) {
  await sbFetch('/wb_campaign_logs', {
    method: 'POST',
    body: JSON.stringify({
      campaign_id,
      phone,
      contact_name: contact_name || '',
      status,
      error_reason: error_reason || null,
      wa_message_id,
      credits_deducted: status === 'sent' ? 1 : 0,
      created_at: new Date().toISOString(),
      sent_at: status === 'sent' ? new Date().toISOString() : null
    }),
  })
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
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'))
})
app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'))
})

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
    const wabaRes = await metaFetch(
      '/me/whatsapp_business_accounts?fields=id,name',
      'GET', undefined, accessToken
    )

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
// CAMPAIGN — START (FIXED)
// ================================================================
app.post('/api/campaign/start', async (req, res) => {
  const { campaign_id, user_id } = req.body
  if (!campaign_id || !user_id)
    return res.status(400).json({ error: 'campaign_id and user_id required' })
  
  if (activeCampaigns[campaign_id]?.status === 'running')
    return res.status(400).json({ error: 'Campaign already running' })

  try {
    // Get campaign
    const campRes = await sbFetch(`/wb_campaigns?id=eq.${campaign_id}&user_id=eq.${user_id}&limit=1`)
    const campaign = campRes.data?.[0]
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

    // Get template
    const tplRes = await sbFetch(`/wb_templates?id=eq.${campaign.template_id}&limit=1`)
    const template = tplRes.data?.[0]
    if (!template) return res.status(404).json({ error: 'Template not found' })
    if (template.status !== 'APPROVED')
      return res.status(400).json({ error: 'Template is not approved' })

    // FIX: Build contact query properly
    // Don't filter by status - all contacts are 'pending' initially
    let contactQuery = `/wb_contacts?user_id=eq.${user_id}&select=*`
    
    // Only filter by group_name if campaign has one (and it's not empty/null)
    if (campaign.group_name && campaign.group_name.trim() !== '') {
      contactQuery += `&group_name=eq.${encodeURIComponent(campaign.group_name)}`
    }
    // If no group_name or empty string, get ALL contacts (no group filter)
    
    console.log(`[campaign] Fetching contacts with query: ${contactQuery}`)
    
    const contactsRes = await sbFetch(contactQuery)
    let contacts = contactsRes.data || []
    
    console.log(`[campaign] Found ${contacts.length} total contacts before filtering`)
    
    if (!contacts.length) {
      const groupInfo = campaign.group_name ? ` in group "${campaign.group_name}"` : ''
      return res.status(400).json({ error: `No contacts found${groupInfo}. Please import contacts first.` })
    }
    
    // Check for blocklisted numbers
    const blocklistRes = await sbFetch(`/wb_blocklist?user_id=eq.${user_id}&select=phone`)
    const blockedPhones = blocklistRes.data?.map(b => b.phone) || []
    const filteredContacts = contacts.filter(c => !blockedPhones.includes(c.phone))
    
    console.log(`[campaign] After blocklist filter: ${filteredContacts.length} contacts`)
    
    if (!filteredContacts.length) 
      return res.status(400).json({ error: 'All contacts are blocklisted' })
    
    contacts = filteredContacts

    // Get WhatsApp account
    const accountRes = await sbFetch(`/wa_accounts?user_id=eq.${user_id}&is_active=eq.true&limit=1`)
    const account = accountRes.data?.[0]
    if (!account) return res.status(400).json({ error: 'No WhatsApp account connected' })
    
    if (account.quality_rating === 'RED') {
      return res.status(400).json({ 
        error: 'Cannot start campaign. Your WhatsApp number quality rating is RED.' 
      })
    }
    
    if (account.quality_rating === 'YELLOW') {
      console.log(`[warning] User ${user_id} has YELLOW quality rating`)
    }

    // Get user settings
    const settingsRes = await sbFetch(`/wb_settings?user_id=eq.${user_id}&limit=1`)
    const settings = settingsRes.data?.[0] || {}
    
    // Check daily limit
    const dailyLimit = settings.day_limit || 0
    if (dailyLimit > 0 && (account.messages_sent_today || 0) >= dailyLimit) {
      return res.status(400).json({ 
        error: `Daily limit reached. You have sent ${account.messages_sent_today || 0} of ${dailyLimit} messages today.` 
      })
    }

    // Check credits
    const profileRes = await sbFetch(`/wb_profiles?id=eq.${user_id}&limit=1`)
    const profile = profileRes.data?.[0]
    if (!profile || profile.credits < contacts.length)
      return res.status(400).json({
        error: `Insufficient credits. Need ${contacts.length}, have ${profile?.credits || 0}.`
      })

    const minGap = (settings.min_gap || 5) * 1000
    const maxGap = (settings.max_gap || 15) * 1000

    // Get existing campaign state if paused
    const existing = activeCampaigns[campaign_id]
    const startIndex = existing?.status === 'paused' ? existing.currentIndex : 0

    activeCampaigns[campaign_id] = {
      status:       'running',
      user_id,
      campaign,
      template,
      account,
      contacts:     contacts,
      settings:     { minGap, maxGap },
      currentIndex: startIndex,
      sent:         existing?.sent    || 0,
      failed:       existing?.failed  || 0,
      log:          existing?.log     || [],
    }

    // Update campaign status in DB
    await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
      method: 'PATCH',
      body:   JSON.stringify({ 
        status: 'running', 
        total_contacts: contacts.length,
        started_at: new Date().toISOString() 
      }),
    })

    // Start the send loop
    runSendLoop(campaign_id)

    res.json({
      success: true,
      total:   contacts.length,
      message: `Campaign started — ${contacts.length} contacts queued`,
    })

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
    method: 'PATCH', body: JSON.stringify({ status: 'paused' }),
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
  if (job) job.status = 'stopped'

  await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'draft' }),
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
        sent:    dbCamp.sent_count || 0,
        failed:  dbCamp.failed_count || 0,
        pending: Math.max(0, (dbCamp.total_contacts || 0) - (dbCamp.sent_count || 0) - (dbCamp.failed_count || 0)),
        total:   dbCamp.total_contacts || 0,
        log:     [],
      })
    }
    return res.json({
      status:  'idle',
      sent:    0,
      failed:  0,
      pending: 0,
      total:   0,
      log:     [],
    })
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
// SEND LOOP
// ================================================================
async function runSendLoop(campaign_id) {
  const job = activeCampaigns[campaign_id]
  if (!job) return

  const { template, account, contacts, settings } = job
  
  if (account.quality_rating === 'RED') {
    job.status = 'paused'
    await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    })
    console.log(`[campaign] ${campaign_id} paused due to RED quality`)
    return
  }
  
  const placeholderMapping = job.campaign.placeholder_mapping || {}

  for (let i = job.currentIndex; i < contacts.length; i++) {
    if (job.status === 'paused' || job.status === 'stopped') {
      job.currentIndex = i
      return
    }
    
    const contact = contacts[i]
    job.currentIndex = i + 1

    const placeholders = template.placeholders || []
    const orderedPositions = placeholders.slice().sort((a, b) => a.position - b.position)
    const placeholderValues = orderedPositions.map(ph => {
      const mappedField = placeholderMapping[`{{${ph.position}}}`]
      if (mappedField === 'name')    return contact.name    || ''
      if (mappedField === 'phone')   return contact.phone   || ''
      if (mappedField === 'message') return contact.message || ''
      if (mappedField && mappedField !== 'custom') return contact[mappedField] || ''
      const customVal = placeholderMapping[`custom_${ph.position}`]
      if (customVal) return customVal
      return ph.sample || ''
    })

    const templateComponents = []

    if (
      template.header_type &&
      template.header_type !== 'NONE' &&
      template.header_type !== 'TEXT' &&
      template.header_type !== 'LOCATION' &&
      template.header_media_url
    ) {
      const mediaKey = template.header_type === 'IMAGE'    ? 'image'
                     : template.header_type === 'VIDEO'    ? 'video'
                     : template.header_type === 'DOCUMENT' ? 'document' : 'image'
      templateComponents.push({
        type: 'header',
        parameters: [{ type: mediaKey, [mediaKey]: { link: template.header_media_url } }],
      })
    }

    if (placeholderValues.length > 0) {
      templateComponents.push({
        type: 'body',
        parameters: placeholderValues.map(v => ({ type: 'text', text: String(v) })),
      })
    }

    const payload = {
      messaging_product: 'whatsapp',
      to:                contact.phone,
      type:              'template',
      template: {
        name:     template.name,
        language: { code: template.language || 'en_US' },
      },
    }
    if (templateComponents.length > 0) payload.template.components = templateComponents

    let success = false
    let errorMsg = ''
    let waMessageId = null

    try {
      const sendRes = await metaFetch(
        `/${account.phone_number_id}/messages`,
        'POST',
        payload,
        account.access_token
      )

      if (sendRes.ok) {
        success = true
        waMessageId = sendRes.data?.messages?.[0]?.id || null
        job.sent++
        job.log.push({ time: new Date().toISOString(), name: contact.name, phone: contact.phone, status: 'sent', error: null })
        const profileRes = await sbFetch(`/wb_profiles?id=eq.${job.user_id}&limit=1`)
        const profile = profileRes.data?.[0]
        if (profile) {
          await sbFetch(`/wb_profiles?id=eq.${job.user_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ credits: Math.max(0, profile.credits - 1) }),
          })
        }
        
        await incrementSentCount(account.id)
        await updateCampaignStats(campaign_id, job.sent, job.failed)
        await insertCampaignLog(campaign_id, contact.phone, contact.name, 'sent', null, waMessageId)
        
      } else {
        errorMsg = sendRes.data?.error?.message || 'Meta API error'
        job.failed++
        job.log.push({ time: new Date().toISOString(), name: contact.name, phone: contact.phone, status: 'failed', error: errorMsg })
        await updateCampaignStats(campaign_id, job.sent, job.failed)
        await insertCampaignLog(campaign_id, contact.phone, contact.name, 'failed', errorMsg)

        if (sendRes.data?.error?.code === 131045 || errorMsg.includes('credit')) {
          job.status = 'stopped'
          await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
            method: 'PATCH', body: JSON.stringify({ status: 'paused' }),
          })
          return
        }
      }
    } catch (err) {
      errorMsg = err.message
      job.failed++
      job.log.push({ time: new Date().toISOString(), name: contact.name, phone: contact.phone, status: 'failed', error: errorMsg })
      await updateCampaignStats(campaign_id, job.sent, job.failed)
      await insertCampaignLog(campaign_id, contact.phone, contact.name, 'failed', errorMsg)
    }

    if (i < contacts.length - 1 && job.status === 'running') {
      await randomDelay(settings.minGap, settings.maxGap)
    }
  }

  if (job.status === 'running') {
    job.status = 'completed'
    await sbFetch(`/wb_campaigns?id=eq.${campaign_id}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() }),
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
        if (field === 'messages')                        await handleMessagesEvent(value)
        else if (field === 'message_template_status_update') await handleTemplateStatusEvent(value)
        else if (field === 'phone_number_quality_update')    await handleQualityUpdate(value)
        else if (field === 'account_alerts')                 console.log('[webhook] account_alert:', JSON.stringify(value))
      } catch (err) {
        console.error(`[webhook][${field}]`, err.message)
      }
    }
  }
})

async function handleMessagesEvent(value) {
  const phoneNumberId = value.metadata?.phone_number_id

  for (const status of (value.statuses || [])) {
    console.log(`[webhook] delivery status: ${status.id} → ${status.status}`)
    await callEdgeInternal('internalDeliveryWebhook', {
      id:           status.id,
      status:       status.status,
      timestamp:    status.timestamp,
      recipient_id: status.recipient_id,
      errors:       status.errors || [],
    })
  }

  for (const msg of (value.messages || [])) {
    console.log(`[webhook] incoming message from ${msg.from}: type=${msg.type}`)
    await handleIncomingMessage(msg, phoneNumberId, value.contacts)
  }
}

async function handleIncomingMessage(msg, phoneNumberId, contacts) {
  const accountRes = await sbFetch(`/wa_accounts?phone_number_id=eq.${phoneNumberId}&is_active=eq.true&limit=1`)
  const account = accountRes.data?.[0]
  if (!account) return

  const userId      = account.user_id
  const senderName  = contacts?.[0]?.profile?.name || msg.from
  let messageText   = ''
  if (msg.type === 'text') messageText = msg.text?.body || ''

  const settingsRes = await sbFetch(`/wb_settings?user_id=eq.${userId}&limit=1`)
  const settings = settingsRes.data?.[0]

  if (messageText && /^(stop|unsubscribe|end|stopall|quit|cancel)$/i.test(messageText.trim())) {
    await handleStopCommand(userId, msg.from, senderName, msg.id)
    if (settings?.auto_reply && account.access_token) {
      await sendAutoReply(msg.from, messageText, settings, account)
    }
    return
  }

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

  if (settings?.auto_reply && messageText && account.access_token) {
    await sendAutoReply(msg.from, messageText, settings, account)
  }
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
// SELF-PINGER
// ================================================================
const PING_INTERVAL = 14 * 60 * 1000

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
})
