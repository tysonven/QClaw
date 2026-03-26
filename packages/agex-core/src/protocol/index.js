/**
 * @agexhq/core — Protocol operations
 * AID verification, manifest signing, AGEX header construction
 */

import { sign, verify, canonicalJson, generateId } from '../crypto/keys.js'

// ── AID Signature Verification (FIX: audit 1.1) ──────────────────────────
// ALWAYS verifies — never silently bypasses

export async function verifyAIDSignature (aid, iaPublicKeyJWK) {
  if (!iaPublicKeyJWK) {
    throw new AgexError('IA_KEY_REQUIRED', 'IA public key required for AID verification', 400)
  }
  const { ia_signature, ...aidBody } = aid
  const canonical = canonicalJson(aidBody)
  const valid = await verify(canonical, ia_signature, iaPublicKeyJWK)
  if (!valid) {
    throw new AgexError('IA_SIGNATURE_INVALID', 'AID ia_signature failed verification', 401)
  }
  return true
}

/**
 * Self-sign an AID using the Hub's own key (dev/self-signed IA mode).
 * The AID is still cryptographically signed — just by the hub instead of an external IA.
 */
export async function selfSignAID (aidBody, hubPrivateKey) {
  const { ia_signature, ...body } = aidBody
  const canonical = canonicalJson(body)
  const signature = await sign(canonical, hubPrivateKey)
  return { ...body, ia_signature: signature }
}

// ── Manifest Signing (FIX: audit 1.3) ─────────────────────────────────────
// Real Ed25519 signatures instead of placeholder strings

export async function signManifest (manifest, privateKey) {
  const { agent_signature, ...body } = manifest
  const canonical = canonicalJson(body)
  return await sign(canonical, privateKey)
}

export async function verifyManifest (manifest, publicKeyJWK) {
  const { agent_signature, ...body } = manifest
  if (!agent_signature || agent_signature === 'sdk-placeholder') return false
  const canonical = canonicalJson(body)
  return await verify(canonical, agent_signature, publicKeyJWK)
}

// ── AGEX Request Headers ──────────────────────────────────────────────────

export function buildAgexHeaders (aidId, version = '1.0') {
  return {
    'X-AGEX-Version': version,
    'X-AGEX-Request-ID': generateId(),
    'X-AGEX-Timestamp': new Date().toISOString(),
    'X-AGEX-AID': aidId
  }
}

export async function signRequest (body, timestamp, requestId, privateKey) {
  const bodyStr = body ? canonicalJson(body) : ''
  const sigInput = `${bodyStr}|${timestamp}|${requestId}`
  return await sign(sigInput, privateKey)
}

export async function verifyRequest (body, timestamp, requestId, signature, publicKeyJWK) {
  const bodyStr = body ? canonicalJson(body) : ''
  const sigInput = `${bodyStr}|${timestamp}|${requestId}`
  return await verify(sigInput, signature, publicKeyJWK)
}

// ── Error class ───────────────────────────────────────────────────────────

export class AgexError extends Error {
  constructor (code, message, statusCode = 400) {
    super(message)
    this.name = 'AgexError'
    this.code = code
    this.statusCode = statusCode
  }
}

// ── Constants ─────────────────────────────────────────────────────────────

export const AGEX_VERSION = '1.0'

export const AUDIT_EVENTS = {
  AID_REGISTERED: 'aid.registered',
  AID_REVOKED: 'aid.revoked',
  CREDENTIAL_REQUESTED: 'credential.requested',
  CREDENTIAL_ISSUED: 'credential.issued',
  CREDENTIAL_REJECTED: 'credential.rejected',
  CREDENTIAL_PENDING: 'credential.pending_approval',
  ROTATION_INITIATED: 'rotation.initiated',
  ROTATION_COMPLETED: 'rotation.completed',
  ROTATION_FAILED: 'rotation.failed',
  DELEGATION_CREATED: 'delegation.created',
  ERS_INITIATED: 'ers.initiated',
  ERS_COMPLETED: 'ers.completed',
  CLC_REVOKED: 'clc.revoked',
  CLC_SUSPENDED: 'clc.suspended',
  CLC_RESUMED: 'clc.resumed',
  APPROVAL_GRANTED: 'approval.granted',
  APPROVAL_REJECTED: 'approval.rejected'
}
