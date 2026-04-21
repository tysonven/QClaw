/**
 * QuantumClaw Approval Gate
 *
 * Intercepts destructive tool calls and enforces approval workflow.
 * Integrates with ExecApprovals system.
 */

import { log } from '../core/logger.js';

export class ApprovalGate {
  constructor(approvals, config = {}) {
    this.approvals = approvals;

    // Tools that bypass every approval check (gated list AND keyword scan).
    // Use for tools whose args naturally contain gated keywords like "send"
    // or "publish" (e.g. spawn_agent role descriptions) but whose execution
    // is already covered by other guardrails — credential scoping, audit
    // logs, rate limits. Adding a tool here is a deliberate security trade.
    this.autoApproveTools = config.autoApproveTools || [
      'spawn_agent',
    ];

    // Tools that require approval before execution
    this.gatedTools = config.gatedTools || [
      'filesystem__write_file',
      'filesystem__edit_file',
      'filesystem__move_file',
      'shell_execute',
      'n8n-router', // Publishing workflows
    ];

    // Keywords in tool args that trigger approval
    this.gatedKeywords = config.gatedKeywords || [
      'publish', 'delete', 'remove', 'drop', 'truncate', 'send', 'post', 'deploy'
    ];

    // Risk assessment weights
    this.riskWeights = {
      filesystem__write_file: 'medium',
      filesystem__edit_file: 'medium',
      filesystem__move_file: 'low',
      shell_execute: 'high',
      'n8n-router': 'high', // Publishing to social/web
    };
  }

  /**
   * Check if a tool call requires approval
   * @param {string} toolName
   * @param {Object} toolArgs
   * @returns {Object} { requiresApproval: boolean, reason: string, riskLevel: string }
   */
  async check(toolName, toolArgs) {
    // 0. Short-circuit for explicitly auto-approved tools — skips keyword scan too
    if (this.autoApproveTools.includes(toolName)) {
      log.debug(`Auto-approved: ${toolName}`);
      return { requiresApproval: false };
    }

    // 1. Check if tool is in gated list
    if (this.gatedTools.includes(toolName)) {
      const riskLevel = this.riskWeights[toolName] || 'medium';
      return {
        requiresApproval: true,
        reason: `${toolName} requires approval (gated tool)`,
        riskLevel,
      };
    }

    // 2. Check if args contain gated keywords
    const argsStr = JSON.stringify(toolArgs).toLowerCase();
    for (const keyword of this.gatedKeywords) {
      if (argsStr.includes(keyword)) {
        return {
          requiresApproval: true,
          reason: `Action contains keyword: "${keyword}"`,
          riskLevel: 'medium',
        };
      }
    }

    // 3. Special checks for specific tools
    if (toolName === 'filesystem__write_file' && toolArgs.path?.includes('src/')) {
      return {
        requiresApproval: true,
        reason: 'Writing to src/ directory',
        riskLevel: 'high',
      };
    }

    if (toolName.includes('stripe') && argsStr.includes('charge')) {
      return {
        requiresApproval: true,
        reason: 'Stripe payment action detected',
        riskLevel: 'critical',
      };
    }

    return { requiresApproval: false };
  }

  /**
   * Request approval and wait for response
   * @param {string} agent - Agent name requesting approval
   * @param {string} toolName
   * @param {Object} toolArgs
   * @param {string} riskLevel
   * @returns {Promise<{approved: boolean, id: number}>}
   */
  async requestApproval(agent, toolName, toolArgs, riskLevel) {
    const action = `${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`;
    const detail = `Agent ${agent} wants to execute: ${action}`;

    log.warn(`⏸️  Approval required: ${action}`);

    const result = await this.approvals.request(agent, toolName, detail, riskLevel);
    return result;
  }

  /**
   * Add a tool to the gated list
   */
  gateToolRuntime(toolName, riskLevel = 'medium') {
    if (!this.gatedTools.includes(toolName)) {
      this.gatedTools.push(toolName);
      this.riskWeights[toolName] = riskLevel;
      log.info(`Gated tool added: ${toolName} (${riskLevel})`);
    }
  }

  /**
   * Remove a tool from gated list (use with caution)
   */
  ungateToolRuntime(toolName) {
    const index = this.gatedTools.indexOf(toolName);
    if (index > -1) {
      this.gatedTools.splice(index, 1);
      log.info(`Tool ungated: ${toolName}`);
    }
  }
}
