/**
 * @agexhq/core — ECDH-ES+AES256GCM Credential Envelope Encryption
 * Implements SR-1 (Credential Confidentiality) and SR-8 (Hub Zero-Knowledge)
 * Pure JavaScript — works on Termux without native compilation
 */

import { x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/hashes/utils'
import { base64url } from 'jose'

// We use Web Crypto API for AES-GCM (available in Node 18+ and Termux)
const subtle = globalThis.crypto?.subtle

/**
 * Encrypt a credential value for a recipient agent.
 * The Hub calls this when brokering credentials — it never sees the plaintext
 * because the SP encrypts for the agent's public key directly.
 *
 * @param {string} plaintext — credential value (API key, token, etc.)
 * @param {Uint8Array} recipientX25519Public — agent's X25519 public key
 * @returns {object} AGEX credential envelope
 */
export async function encryptEnvelope (plaintext, recipientX25519Public) {
  // Generate ephemeral X25519 keypair
  const ephPriv = randomBytes(32)
  const ephPub = x25519.getPublicKey(ephPriv)

  // ECDH shared secret
  const shared = x25519.getSharedSecret(ephPriv, recipientX25519Public)

  // HKDF key derivation
  const key = hkdf(sha256, shared, /* salt */ new Uint8Array(0), 'AGEX-CLC-v1', 32)

  // AES-256-GCM via Web Crypto
  const nonce = randomBytes(12)
  const plainBytes = new TextEncoder().encode(plaintext)

  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, plainBytes)

  // Web Crypto appends tag to ciphertext
  const sealedBytes = new Uint8Array(sealed)
  const ciphertext = sealedBytes.slice(0, -16)
  const tag = sealedBytes.slice(-16)

  return {
    algorithm: 'ECDH-ES+AES256GCM',
    epk: { kty: 'OKP', crv: 'X25519', x: base64url.encode(ephPub) },
    ciphertext: base64url.encode(ciphertext),
    nonce: base64url.encode(nonce),
    tag: base64url.encode(tag)
  }
}

/**
 * Decrypt a credential envelope using the agent's X25519 private key.
 *
 * @param {object} envelope — AGEX credential envelope
 * @param {Uint8Array} recipientX25519Private — agent's X25519 private key bytes
 * @returns {string} decrypted credential value
 */
export async function decryptEnvelope (envelope, recipientX25519Private) {
  const ephPub = base64url.decode(envelope.epk.x)

  // ECDH shared secret
  const shared = x25519.getSharedSecret(recipientX25519Private, ephPub)

  // Same HKDF derivation
  const key = hkdf(sha256, shared, new Uint8Array(0), 'AGEX-CLC-v1', 32)

  const nonce = base64url.decode(envelope.nonce)
  const ciphertext = base64url.decode(envelope.ciphertext)
  const tag = base64url.decode(envelope.tag)

  // Reconstruct sealed = ciphertext || tag
  const sealed = new Uint8Array(ciphertext.length + tag.length)
  sealed.set(ciphertext)
  sealed.set(tag, ciphertext.length)

  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, sealed)

  return new TextDecoder().decode(plain)
}

/**
 * Convert an Ed25519 private key to X25519 for ECDH.
 * Ed25519 and X25519 share the same underlying curve (Curve25519).
 */
export function ed25519PrivateToX25519 (ed25519PrivateBase64url) {
  const privBytes = base64url.decode(ed25519PrivateBase64url)
  return edwardsToMontgomeryPriv(privBytes)
}

/**
 * Convert an Ed25519 public key JWK to X25519 public key bytes.
 * Uses the birational map from Ed25519 to X25519 (Montgomery form).
 */
export function ed25519PublicToX25519 (publicKeyJWK) {
  const edPub = base64url.decode(publicKeyJWK.x)
  return edwardsToMontgomeryPub(edPub)
}
