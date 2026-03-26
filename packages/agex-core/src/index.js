/**
 * @agexhq/core — AGEX Protocol Primitives
 * The foundation package for the entire AGEX ecosystem.
 * Pure JavaScript — zero native dependencies — works everywhere including Termux.
 */

// ── Crypto ────────────────────────────────────────────────────────────────
export {
  generateKeypair, publicKeyToJWK, jwkToPublicKeyBytes,
  sign, verify,
  canonicalJson,
  sha3Hash, sha256Hash,
  computeEventHash,
  generateId, generateNonce,
  base64url, randomBytes
} from './crypto/keys.js'

export {
  encryptEnvelope, decryptEnvelope,
  ed25519PrivateToX25519
} from './crypto/ecdh.js'

// ── Schemas ───────────────────────────────────────────────────────────────
export {
  AIDSchema, ManifestSchema, CLCSchema,
  ServiceProviderSchema,
  PolicyDocSchema, PolicyRuleSchema, PolicyConditionSchema
} from './schemas/index.js'

// ── Protocol ──────────────────────────────────────────────────────────────
export {
  verifyAIDSignature, selfSignAID,
  signManifest, verifyManifest,
  buildAgexHeaders, signRequest, verifyRequest,
  AgexError,
  AGEX_VERSION, AUDIT_EVENTS
} from './protocol/index.js'

// ── Policy Engine ─────────────────────────────────────────────────────────
export { evaluatePolicy, evaluateCondition } from './policy/index.js'
