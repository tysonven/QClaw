/**
 * @agexhq/core — Zod schemas for all AGEX protocol objects
 * Single source of truth — used by hub, SDK, and CLI
 */

import { z } from 'zod'

// ── AID Schema (Agent Identity Document) ──────────────────────────────────

export const AIDSchema = z.object({
  aid_version: z.literal('1.0'),
  aid_id: z.string().uuid(),
  issuer: z.object({
    ia_id: z.string(),
    ia_name: z.string(),
    ia_cert_id: z.string()
  }),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  agent: z.object({
    name: z.string().optional(),
    type: z.enum(['orchestrator', 'worker', 'specialist', 'gateway']),
    capabilities: z.array(z.string()).default([]),
    principal: z.object({
      organisation: z.string(),
      org_id: z.string(),
      contact: z.string().email(),
      jurisdiction: z.string()
    })
  }),
  trust_tier: z.number().int().min(0).max(3),
  public_key: z.object({ kty: z.string(), crv: z.string(), x: z.string() }),
  restrictions: z.object({
    allowed_services: z.array(z.string()).optional(),
    max_clc_duration_seconds: z.number().int().optional(),
    max_delegation_depth: z.number().int().min(0).max(5).optional(),
    geo_restrictions: z.array(z.string()).optional()
  }).default({}),
  ia_signature: z.string()
})

// ── Intent Manifest Schema ────────────────────────────────────────────────

export const ManifestSchema = z.object({
  manifest_version: z.literal('1.0'),
  manifest_id: z.string().uuid(),
  requesting_aid: z.string().uuid(),
  target: z.object({
    service_id: z.string(),
    requested_scopes: z.array(z.string()).min(1),
    minimum_scopes: z.array(z.string()).optional(),
    environment: z.enum(['production', 'staging', 'development']).default('production')
  }),
  intent: z.object({
    summary: z.string().max(500),
    task_type: z.enum(['read', 'write', 'read_write', 'admin', 'transact', 'notify']),
    data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
    automated: z.boolean().default(true),
    reversible: z.boolean().default(true),
    human_visible: z.boolean().default(false)
  }),
  duration: z.object({
    max_duration_seconds: z.number().int().min(60).max(604800),
    idle_timeout_seconds: z.number().int().min(60).default(3600)
  }),
  data_handling: z.object({
    pii_processing: z.boolean().default(false),
    cross_border_transfer: z.boolean().default(false),
    deletion_on_completion: z.boolean().default(false)
  }).default({}),
  agent_signature: z.string()
})

// ── CLC Schema (Credential Lifecycle Contract) ────────────────────────────

export const CLCSchema = z.object({
  clc_version: z.literal('1.0'),
  clc_id: z.string().uuid(),
  beneficiary_aid: z.string().uuid(),
  manifest_id: z.string().uuid(),
  manifest_hash: z.string(),
  credential_envelope: z.object({
    algorithm: z.string(),
    epk: z.object({ kty: z.string(), crv: z.string(), x: z.string() }),
    ciphertext: z.string(),
    nonce: z.string(),
    tag: z.string()
  }),
  granted_scopes: z.array(z.string()),
  scope_ceiling: z.array(z.string()),
  validity: z.object({
    not_before: z.string().datetime(),
    not_after: z.string().datetime(),
    idle_timeout_seconds: z.number().int().default(3600)
  }),
  rotation_policy: z.object({
    rotation_interval_seconds: z.number().int(),
    rotation_overlap_seconds: z.number().int(),
    key_derivation_function: z.string().default('HKDF-SHA256')
  }),
  delegation_policy: z.object({
    delegation_permitted: z.boolean(),
    max_delegation_depth: z.number().int().min(0).max(5),
    max_further_delegation: z.number().int().min(0).default(0)
  }),
  chain_provenance: z.array(z.string()).default([]),
  provider_signature: z.string(),
  hub_binding: z.object({
    hub_id: z.string(),
    hub_signature: z.string()
  })
})

// ── Service Provider Schema (NEW — fixes audit 3.1) ──────────────────────

export const ServiceProviderSchema = z.object({
  sp_id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/, 'sp_id must be lowercase alphanumeric with dots/hyphens/underscores'),
  sp_name: z.string().min(1).max(256),
  service_url: z.string().url(),
  credential_endpoint: z.string().url(),
  policy_endpoint: z.string().url().optional(),
  public_key_jwk: z.object({ kty: z.string(), crv: z.string(), x: z.string() }),
  supported_scopes: z.array(z.string()).default([])
})

// ── APL Policy Schema ─────────────────────────────────────────────────────

export const PolicyConditionSchema = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('trust_tier'), operator: z.enum(['eq', 'gt', 'gte', 'lt', 'lte']), value: z.number() }),
  z.object({ type: z.literal('scope'), operator: z.enum(['contains_any', 'contains_all', 'subset_of']), values: z.array(z.string()) }),
  z.object({ type: z.literal('intent_type'), operator: z.enum(['eq', 'in']), value: z.string().optional(), values: z.array(z.string()).optional() }),
  z.object({ type: z.literal('data_classification'), operator: z.enum(['eq', 'gte', 'lte']), value: z.string() }),
  z.object({ type: z.literal('pii_processing'), value: z.boolean() }),
  z.object({ type: z.literal('environment'), operator: z.enum(['eq', 'in']), value: z.string().optional(), values: z.array(z.string()).optional() }),
  z.object({ type: z.literal('time_window'), start_hour: z.number().optional(), end_hour: z.number().optional(), days_of_week: z.array(z.string()).optional() }),
  z.object({ type: z.literal('geography'), operator: z.enum(['agent_in', 'agent_not_in', 'restricted_to']), values: z.array(z.string()) }),
  z.object({ type: z.literal('and'), conditions: z.array(PolicyConditionSchema) }),
  z.object({ type: z.literal('or'), conditions: z.array(PolicyConditionSchema) }),
  z.object({ type: z.literal('not'), condition: PolicyConditionSchema }),
]))

export const PolicyRuleSchema = z.object({
  rule_id: z.string(),
  priority: z.number().int().default(99),
  condition: PolicyConditionSchema.optional(),
  action: z.enum(['approve', 'reject', 'review']),
  description: z.string().optional()
})

export const PolicyDocSchema = z.object({
  rules: z.array(PolicyRuleSchema),
  default_action: z.enum(['approve', 'reject', 'review']).default('reject')
})
