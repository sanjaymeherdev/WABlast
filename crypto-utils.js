// crypto-utils.js — AES-256-GCM encryption for tokens at rest
// Requires env var TOKEN_ENCRYPTION_KEY: a 32-byte key, base64-encoded.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const crypto = require('crypto')

const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64')
if (KEY.length !== 32) {
  throw new Error(
    'TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
  )
}

// NOTE ON FORMAT: this must stay byte-compatible with the Deno/Web Crypto
// side (supabase/functions/wablast/crypto-utils.ts), which is used to
// decrypt these same tokens inside the Edge Function. Web Crypto's
// AES-GCM always appends the 16-byte auth tag directly onto the
// ciphertext ("combined" below) — Node's crypto module normally keeps
// them separate (getAuthTag()), so we manually concatenate here to match.
// Stored format: "<iv_base64>:<combined_base64>"

function encryptToken(plaintext) {
  const iv = crypto.randomBytes(12) // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag() // 16 bytes
  const combined = Buffer.concat([ciphertext, authTag])
  return `${iv.toString('base64')}:${combined.toString('base64')}`
}

function decryptToken(stored) {
  const [ivB64, combinedB64] = stored.split(':')
  if (!ivB64 || !combinedB64) throw new Error('Malformed encrypted token')
  const iv = Buffer.from(ivB64, 'base64')
  const combined = Buffer.from(combinedB64, 'base64')
  const authTag = combined.subarray(combined.length - 16)
  const ciphertext = combined.subarray(0, combined.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

module.exports = { encryptToken, decryptToken }
