/**
 * @agexhq/core — Cryptographic primitives
 * Ed25519 key generation, signing, verification
 * All pure JavaScript via @noble — zero native deps
 */

import { ed25519 as ed } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { sha3_256 } from '@noble/hashes/sha3'
import { randomBytes } from '@noble/hashes/utils'
import { base64url } from 'jose'
import { v4 as uuidv4 } from 'uuid'

// ── Key Generation ────────────────────────────────────────────────────────

export function generateKeypair () {
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = ed.getPublicKey(privateKey)
  return {
    privateKey: base64url.encode(privateKey),
    publicKey: base64url.encode(publicKey),
    jwk: publicKeyToJWK(publicKey)
  }
}

export function publicKeyToJWK (publicKeyBytes) {
  return { kty: 'OKP', crv: 'Ed25519', x: base64url.encode(publicKeyBytes) }
}

export function jwkToPublicKeyBytes (jwk) {
  return base64url.decode(jwk.x)
}

// ── Signing ───────────────────────────────────────────────────────────────

export function sign (message, privateKeyBase64url) {
  const privBytes = base64url.decode(privateKeyBase64url)
  const msgBytes = typeof message === 'string'
    ? new TextEncoder().encode(message)
    : message
  const sig = ed.sign(msgBytes, privBytes)
  return base64url.encode(sig)
}

export function verify (message, signatureBase64url, publicKeyJWK) {
  try {
    const pubBytes = jwkToPublicKeyBytes(publicKeyJWK)
    const sigBytes = base64url.decode(signatureBase64url)
    const msgBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message
    return ed.verify(sigBytes, msgBytes, pubBytes)
  } catch {
    return false
  }
}

// ── Canonical JSON (RFC 8785 — fixed edge cases from audit 3.3) ──────────

export function canonicalJson (obj) {
  if (obj === null) return 'null'
  if (obj === undefined) return undefined
  if (typeof obj === 'boolean') return String(obj)
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return 'null'
    return Object.is(obj, -0) ? '0' : String(obj)
  }
  if (typeof obj === 'string') return JSON.stringify(obj)
  if (obj instanceof Date) return JSON.stringify(obj.toISOString())
  if (Array.isArray(obj)) {
    return '[' + obj.map(v => {
      const s = canonicalJson(v)
      return s === undefined ? 'null' : s
    }).join(',') + ']'
  }
  if (typeof obj === 'object') {
    const pairs = Object.keys(obj)
      .sort()
      .map(k => {
        const v = canonicalJson(obj[k])
        if (v === undefined) return undefined
        return JSON.stringify(k) + ':' + v
      })
      .filter(p => p !== undefined)
    return '{' + pairs.join(',') + '}'
  }
  return 'null'
}

// ── Hashing ───────────────────────────────────────────────────────────────

export function sha3Hash (data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data) : data
  return Buffer.from(sha3_256(bytes)).toString('hex')
}

export function sha256Hash (data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data) : data
  return Buffer.from(sha256(bytes)).toString('hex')
}

// ── Audit Hash Chain ──────────────────────────────────────────────────────

export function computeEventHash (event, prevHash) {
  const payload = canonicalJson({ ...event, prev_hash: prevHash })
  return sha3Hash(payload)
}

// ── ID Generation ─────────────────────────────────────────────────────────

export function generateId () { return uuidv4() }

export function generateNonce () {
  return base64url.encode(randomBytes(16))
}

export { base64url, randomBytes }
