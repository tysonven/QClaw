/**
 * @agexhq/core — AGEX Policy Language (APL) Evaluation Engine
 * Deterministic, stateless policy evaluation
 */

export function evaluatePolicy (policy, aid, manifest) {
  const rules = [...(policy.rules || [])].sort((a, b) => (a.priority || 99) - (b.priority || 99))

  for (const rule of rules) {
    const matched = evaluateCondition(rule.condition, aid, manifest)
    if (matched) {
      return {
        action: rule.action,
        rule_id: rule.rule_id,
        reason: rule.description || `Matched rule: ${rule.rule_id}`
      }
    }
  }

  return {
    action: policy.default_action || 'reject',
    reason: 'No rules matched; applying default_action'
  }
}

export function evaluateCondition (condition, aid, manifest) {
  if (!condition) return true

  switch (condition.type) {

    case 'trust_tier': {
      const tier = typeof aid.trust_tier === 'number' ? aid.trust_tier : parseInt(aid.trust_tier)
      switch (condition.operator) {
        case 'gte': return tier >= condition.value
        case 'lte': return tier <= condition.value
        case 'eq': return tier === condition.value
        case 'gt': return tier > condition.value
        case 'lt': return tier < condition.value
        default: return false
      }
    }

    case 'scope': {
      const requested = manifest.target?.requested_scopes || []
      if (condition.operator === 'contains_any') {
        return condition.values.some(s => requested.includes(s))
      }
      if (condition.operator === 'contains_all') {
        return condition.values.every(s => requested.includes(s))
      }
      if (condition.operator === 'subset_of') {
        return requested.every(s => condition.values.includes(s))
      }
      return false
    }

    case 'intent_type': {
      const taskType = manifest.intent?.task_type
      if (condition.operator === 'eq') return taskType === condition.value
      if (condition.operator === 'in') return (condition.values || []).includes(taskType)
      return false
    }

    case 'data_classification': {
      const dc = manifest.intent?.data_classification
      const levels = ['public', 'internal', 'confidential', 'restricted']
      const reqLevel = levels.indexOf(dc)
      const condLevel = levels.indexOf(condition.value)
      if (condition.operator === 'lte') return reqLevel <= condLevel
      if (condition.operator === 'gte') return reqLevel >= condLevel
      if (condition.operator === 'eq') return reqLevel === condLevel
      return false
    }

    case 'pii_processing':
      return manifest.data_handling?.pii_processing === condition.value

    case 'environment': {
      const env = manifest.target?.environment
      if (condition.operator === 'eq') return env === condition.value
      if (condition.operator === 'in') return (condition.values || []).includes(env)
      return false
    }

    case 'time_window': {
      const now = new Date()
      const hour = now.getUTCHours()
      const day = now.getUTCDay()
      const inHours = hour >= (condition.start_hour || 0) && hour < (condition.end_hour || 24)
      const inDays = !condition.days_of_week ||
        condition.days_of_week.includes(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day])
      return inHours && inDays
    }

    // FIX: audit 2.6 — clarified geography semantics
    case 'geography': {
      const agentJurisdiction = aid.agent?.principal?.jurisdiction ||
        (typeof aid.restrictions === 'string' ? JSON.parse(aid.restrictions) : aid.restrictions)?.geo_restrictions?.[0]
      const allowedRegions = (typeof aid.restrictions === 'string' ? JSON.parse(aid.restrictions) : aid.restrictions)?.geo_restrictions || []

      if (condition.operator === 'agent_in') {
        return condition.values.includes(agentJurisdiction)
      }
      if (condition.operator === 'agent_not_in') {
        return !condition.values.includes(agentJurisdiction)
      }
      if (condition.operator === 'restricted_to') {
        return condition.values.every(v => allowedRegions.includes(v))
      }
      // Backwards compat with old in/not_in operators
      if (condition.operator === 'in') {
        return condition.values.some(v => allowedRegions.includes(v))
      }
      if (condition.operator === 'not_in') {
        return !condition.values.some(v => allowedRegions.includes(v))
      }
      return false
    }

    case 'and':
      return (condition.conditions || []).every(c => evaluateCondition(c, aid, manifest))

    case 'or':
      return (condition.conditions || []).some(c => evaluateCondition(c, aid, manifest))

    case 'not':
      return !evaluateCondition(condition.condition, aid, manifest)

    default:
      console.warn(`[APL] Unknown condition type: ${condition.type}`)
      return false
  }
}
