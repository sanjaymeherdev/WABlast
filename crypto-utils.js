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

function encryptToken(plaintext) {
  const iv = crypto.randomBytes(12) // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Store as iv:authTag:ciphertext, each base64
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

function decryptToken(stored) {
  const [ivB64, tagB64, ctB64] = stored.split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted token')
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

module.exports = { encryptToken, decryptToken }
