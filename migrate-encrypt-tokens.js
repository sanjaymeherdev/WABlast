// migrate-encrypt-tokens.js — one-time script to encrypt existing plaintext tokens
// Run AFTER adding the encrypted_access_token column (see migration.sql)
// and BEFORE dropping the old access_token column.
//
// Usage: node migrate-encrypt-tokens.js

require('dotenv').config()
const fetch = require('node-fetch')
const { encryptToken } = require('./crypto-utils')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

async function main() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/wa_accounts?select=id,access_token`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const rows = await res.json()
  console.log(`Found ${rows.length} rows to migrate`)

  for (const row of rows) {
    if (!row.access_token) continue
    const encrypted = encryptToken(row.access_token)
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_accounts?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encrypted_access_token: encrypted }),
    })
    if (!patchRes.ok) {
      console.error(`Failed to migrate row ${row.id}:`, await patchRes.text())
    } else {
      console.log(`Migrated row ${row.id}`)
    }
  }
  console.log('Done. Verify encrypted_access_token is populated for all rows, then run:')
  console.log('  alter table public.wa_accounts drop column access_token;')
  console.log('  alter table public.wa_accounts rename column encrypted_access_token to access_token;')
}

main().catch(err => { console.error(err); process.exit(1) })
