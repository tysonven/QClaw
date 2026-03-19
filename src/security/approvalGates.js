/**
 * QuantumClaw — Approval Gates
 *
 * Intercepts destructive/financial actions and requires explicit approval.
 * Logs all gated actions to audit trail.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

class ApprovalGates {
  constructor(agentName, workspaceDir) {
    this.agentName = agentName;
    this.auditPath = join(workspaceDir, 'agents', agentName, 'memory', 'audit.log');
    this.pendingApprovals = new Map(); // requestId -> { action, timestamp, details }
  }

  /**
   * Check if tool call requires approval (executor interface)
   */
  async check(toolName, toolArgs) {
    const requiresApproval = this._requiresApproval(toolName, toolArgs);
    
    if (!requiresApproval) {
      return { requiresApproval: false };
    }

    const reason = this._getApprovalReason(toolName, toolArgs);
    const riskLevel = this._getRiskLevel(toolName, toolArgs);

    return {
      requiresApproval: true,
      reason,
      riskLevel
    };
  }

  /**
   * Check if an action requires approval (internal)
   */
  _requiresApproval(toolName, toolArgs) {
    const skill = toolName.split('_')[0]; // e.g. 'stripe' from 'stripe_create_charge'
    const argsStr = JSON.stringify(toolArgs || {});
    
    // Extract endpoint-like patterns
    const endpoint = toolArgs?.endpoint || toolArgs?.path || '';
    const method = toolArgs?.method || 'GET';
    // Financial operations
    if (toolName.includes('stripe')) {
      if (method === 'POST' && endpoint.includes('/charges')) return true;
      if (method === 'POST' && endpoint.includes('/refunds')) return true;
      if (method === 'POST' && endpoint.includes('/invoices') && toolArgs?.auto_advance) return true;
      if (argsStr.includes('charge') || argsStr.includes('refund')) return true;
    }

    // Destructive CRM operations
    if (toolName.includes('ghl')) {
      if (method === 'DELETE') return true;
      if (method === 'POST' && endpoint.includes('/opportunities') && toolArgs?.monetary_value > 10000) return true;
    }

    // Publishing operations  
    if (toolName.includes('n8n')) {
      if (endpoint.includes('/qclaw-social') && toolArgs?.publish_now === true) return true;
      if (endpoint.includes('/qclaw-wordpress') && toolArgs?.status === 'publish') return true;
    }

    // Destructive file operations
    if (toolName.includes('write_file') || toolName.includes('delete') || toolName.includes('move_file')) {
      return true;
    }

    // Shell commands
    if (toolName === 'shell_execute' || toolName.includes('shell')) {
      return true;
    }

    return false;
  }

  /**
   * Get approval reason
   */
  _getApprovalReason(toolName, toolArgs) {
    if (toolName.includes('stripe')) return 'Financial transaction requires approval';
    if (toolName.includes('ghl') && toolArgs?.method === 'DELETE') return 'Destructive CRM operation';
    if (toolName.includes('n8n') && (toolArgs?.publish_now || toolArgs?.status === 'publish')) return 'Publishing action';
    if (toolName.includes('write_file')) return 'File modification';
    if (toolName.includes('shell')) return 'Shell command execution';
    return 'High-risk operation';
  }

  /**
   * Get risk level
   */
  _getRiskLevel(toolName, toolArgs) {
    if (toolName.includes('stripe')) return 'high';
    if (toolName.includes('delete') || toolName.includes('refund')) return 'high';
    if (toolName.includes('shell')) return 'medium';
    return 'medium';
  }

  /**
   * Request approval for an action
   * Returns: { approved: false, requestId: string, message: string }
   */
  async requestApproval(agentName, toolName, toolArgs, riskLevel = 'medium') {
    const endpoint = toolArgs?.endpoint || toolArgs?.path || '';
    const method = toolArgs?.method || 'POST';
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const request = {
      toolName,
      endpoint,
      method,
      args: toolArgs,
      riskLevel,
      timestamp: new Date().toISOString(),
      agent: agentName
    };

    this.pendingApprovals.set(requestId, request);

    // Log to audit trail
    await this._logAudit({
      type: 'APPROVAL_REQUESTED',
      requestId,
      ...request
    });

    return {
      approved: false,
      requestId,
      message: `⚠️ Approval required for ${toolName}\n\nRisk: ${riskLevel}\nRequest ID: ${requestId}\n\nTo approve: !approve ${requestId}\nTo reject: !reject ${requestId}`,
      details: request
    };
  }

  /**
   * Approve a pending request
   */
  async approve(requestId, approvedBy = 'owner') {
    const request = this.pendingApprovals.get(requestId);
    if (!request) {
      return { success: false, error: 'Request not found or already processed' };
    }

    this.pendingApprovals.delete(requestId);

    await this._logAudit({
      type: 'APPROVAL_GRANTED',
      requestId,
      approvedBy,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      message: `✅ Approved: ${request.skill}.${request.method} ${request.endpoint}`,
      request
    };
  }

  /**
   * Reject a pending request
   */
  async reject(requestId, rejectedBy = 'owner') {
    const request = this.pendingApprovals.get(requestId);
    if (!request) {
      return { success: false, error: 'Request not found or already processed' };
    }

    this.pendingApprovals.delete(requestId);

    await this._logAudit({
      type: 'APPROVAL_REJECTED',
      requestId,
      rejectedBy,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      message: `❌ Rejected: ${request.skill}.${request.method} ${request.endpoint}`,
      request
    };
  }

  /**
   * List all pending approvals
   */
  listPending() {
    const pending = [];
    for (const [requestId, request] of this.pendingApprovals.entries()) {
      pending.push({
        requestId,
        skill: request.skill,
        endpoint: request.endpoint,
        method: request.method,
        timestamp: request.timestamp,
        age: Date.now() - new Date(request.timestamp).getTime()
      });
    }
    return pending;
  }

  /**
   * Auto-expire approvals older than 1 hour
   */
  async expirePending() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    for (const [requestId, request] of this.pendingApprovals.entries()) {
      const age = now - new Date(request.timestamp).getTime();
      if (age > oneHour) {
        await this._logAudit({
          type: 'APPROVAL_EXPIRED',
          requestId,
          timestamp: new Date().toISOString()
        });
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  /**
   * Log to audit trail
   */
  async _logAudit(entry) {
    const logLine = `${entry.timestamp || new Date().toISOString()} [${entry.type}] ${JSON.stringify(entry)}\n`;
    try {
      await fs.appendFile(this.auditPath, logLine);
    } catch (err) {
      console.error('Failed to write audit log:', err);
    }
  }
}

export default ApprovalGates;
