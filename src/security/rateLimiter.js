/**
 * QuantumClaw — Rate Limiter
 *
 * Prevents runaway API calls and tracks usage per skill/endpoint.
 * Configurable limits with automatic reset windows.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

class RateLimiter {
  constructor(agentName, workspaceDir, limits = {}) {
    this.agentName = agentName;
    this.auditPath = join(workspaceDir, 'agents', agentName, 'memory', 'audit.log');
    
    // Default limits (per hour)
    this.limits = {
      stripe: limits.stripe || 100,
      ghl: limits.ghl || 200,
      'n8n-router': limits['n8n-router'] || 50,
      default: limits.default || 50
    };

    // Usage tracking: { skill: { count, resetAt } }
    this.usage = new Map();
    
    // Start cleanup interval (every 5 minutes)
    this.cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  /**
   * Check if request is within rate limit (executor interface)
   * Returns: { allowed: boolean, remaining: number, resetAt: Date, reason?: string }
   */
  async check(category) {
    return await this.checkLimit(category);
  }

  /**
   * Consume a rate limit slot (executor interface)
   */
  async consume(category) {
    await this.increment(category);
  }

  /**
   * Check if skill is within rate limit
   * Returns: { allowed: boolean, remaining: number, resetAt: Date, reason?: string }
   */
  async checkLimit(skill) {
    const limit = this.limits[skill] || this.limits.default;
    const now = Date.now();
    
    let tracker = this.usage.get(skill);
    
    // Initialize or reset if window expired
    if (!tracker || now >= tracker.resetAt) {
      tracker = {
        count: 0,
        resetAt: now + (60 * 60 * 1000) // 1 hour from now
      };
      this.usage.set(skill, tracker);
    }

    const allowed = tracker.count < limit;
    const remaining = Math.max(0, limit - tracker.count);

    if (!allowed) {
      await this._logAudit({
        type: 'RATE_LIMIT_EXCEEDED',
        skill,
        count: tracker.count,
        limit,
        resetAt: new Date(tracker.resetAt).toISOString()
      });
      
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(tracker.resetAt),
        reason: `Rate limit exceeded for ${skill} (${tracker.count}/${limit}). Resets at ${new Date(tracker.resetAt).toLocaleTimeString()}`
      };
    }

    return {
      allowed,
      remaining,
      resetAt: new Date(tracker.resetAt)
    };
  }

  /**
   * Increment usage counter for a skill
   */
  async increment(skill) {
    const tracker = this.usage.get(skill);
    if (tracker) {
      tracker.count++;
      
      // Log warning at 80% threshold
      const limit = this.limits[skill] || this.limits.default;
      if (tracker.count === Math.floor(limit * 0.8)) {
        await this._logAudit({
          type: 'RATE_LIMIT_WARNING',
          skill,
          count: tracker.count,
          limit,
          threshold: '80%'
        });
      }
    }
  }

  /**
   * Get current usage stats
   */
  getStats() {
    const stats = {};
    for (const [skill, tracker] of this.usage.entries()) {
      const limit = this.limits[skill] || this.limits.default;
      stats[skill] = {
        count: tracker.count,
        limit,
        remaining: Math.max(0, limit - tracker.count),
        resetAt: new Date(tracker.resetAt).toISOString(),
        usage: `${tracker.count}/${limit}`
      };
    }
    return stats;
  }

  /**
   * Clean up expired windows
   */
  _cleanup() {
    const now = Date.now();
    for (const [skill, tracker] of this.usage.entries()) {
      if (now >= tracker.resetAt) {
        this.usage.delete(skill);
      }
    }
  }

  /**
   * Shutdown cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Log to audit trail
   */
  async _logAudit(entry) {
    const logLine = `${new Date().toISOString()} [${entry.type}] ${JSON.stringify(entry)}\n`;
    try {
      await fs.appendFile(this.auditPath, logLine);
    } catch (err) {
      console.error('Failed to write audit log:', err);
    }
  }
}

export default RateLimiter;
