/**
 * QuantumClaw Rate Limiter
 *
 * Enforces daily caps on tool execution by category.
 * Prevents runaway automation costs.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { log } from '../core/logger.js';

export class RateLimiter {
  constructor(config) {
    this.dataPath = join(config._dir, 'rate-limits.json');
    this.limits = config.rateLimits || {
      social_posts: { daily: 10, hourly: 3 },
      emails: { daily: 50, hourly: 10 },
      file_changes: { daily: 100, hourly: 20 },
      api_calls: { daily: 1000, hourly: 200 },
      shell_commands: { daily: 50, hourly: 10 },
    };
    this._loadState();
  }

  _loadState() {
    try {
      if (existsSync(this.dataPath)) {
        this.state = JSON.parse(readFileSync(this.dataPath, 'utf8'));
      } else {
        this.state = { daily: {}, hourly: {}, lastReset: { daily: Date.now(), hourly: Date.now() } };
      }
    } catch (err) {
      log.warn(`Rate limiter state corrupt, resetting: ${err.message}`);
      this.state = { daily: {}, hourly: {}, lastReset: { daily: Date.now(), hourly: Date.now() } };
    }
  }

  _saveState() {
    writeFileSync(this.dataPath, JSON.stringify(this.state, null, 2));
  }

  _resetIfNeeded() {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;

    if (now - this.state.lastReset.hourly > hourMs) {
      this.state.hourly = {};
      this.state.lastReset.hourly = now;
      log.debug('Rate limiter: hourly limits reset');
    }

    if (now - this.state.lastReset.daily > dayMs) {
      this.state.daily = {};
      this.state.lastReset.daily = now;
      log.debug('Rate limiter: daily limits reset');
    }
  }

  /**
   * Check if action is allowed under rate limits
   * @param {string} category - e.g. 'social_posts', 'emails', 'file_changes'
   * @param {number} count - how many units to consume (default 1)
   * @returns {Object} { allowed: boolean, reason?: string, remaining?: {daily, hourly} }
   */
  check(category, count = 1) {
    this._resetIfNeeded();

    const limits = this.limits[category];
    if (!limits) {
      // No limit defined for this category
      return { allowed: true };
    }

    const dailyUsed = (this.state.daily[category] || 0);
    const hourlyUsed = (this.state.hourly[category] || 0);

    if (limits.daily && dailyUsed + count > limits.daily) {
      return {
        allowed: false,
        reason: `Daily limit exceeded for ${category} (${limits.daily}/day)`,
        remaining: { daily: 0, hourly: Math.max(0, limits.hourly - hourlyUsed) },
      };
    }

    if (limits.hourly && hourlyUsed + count > limits.hourly) {
      return {
        allowed: false,
        reason: `Hourly limit exceeded for ${category} (${limits.hourly}/hour)`,
        remaining: { daily: Math.max(0, limits.daily - dailyUsed), hourly: 0 },
      };
    }

    return {
      allowed: true,
      remaining: {
        daily: limits.daily ? limits.daily - dailyUsed - count : Infinity,
        hourly: limits.hourly ? limits.hourly - hourlyUsed - count : Infinity,
      },
    };
  }

  /**
   * Consume rate limit quota (call after action succeeds)
   */
  consume(category, count = 1) {
    this._resetIfNeeded();
    this.state.daily[category] = (this.state.daily[category] || 0) + count;
    this.state.hourly[category] = (this.state.hourly[category] || 0) + count;
    this._saveState();
    log.debug(`Rate limit consumed: ${category} +${count}`);
  }

  /**
   * Get current usage stats
   */
  getUsage() {
    this._resetIfNeeded();
    const usage = {};
    for (const category in this.limits) {
      usage[category] = {
        daily: { used: this.state.daily[category] || 0, limit: this.limits[category].daily },
        hourly: { used: this.state.hourly[category] || 0, limit: this.limits[category].hourly },
      };
    }
    return usage;
  }

  /**
   * Override limits (for testing or manual adjustment)
   */
  setLimits(category, daily, hourly) {
    this.limits[category] = { daily, hourly };
    log.info(`Rate limits updated for ${category}: ${daily}/day, ${hourly}/hour`);
  }
}
