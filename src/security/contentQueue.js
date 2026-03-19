/**
 * QuantumClaw — Content Queue
 *
 * Stages content before publishing. Review queue with approve/reject.
 * Prevents accidental live publishing and maintains audit trail.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

class ContentQueue {
  constructor(agentName, workspaceDir) {
    this.agentName = agentName;
    this.queueDir = join(workspaceDir, 'agents', agentName, 'memory', 'content-queue');
    this.auditPath = join(workspaceDir, 'agents', agentName, 'memory', 'audit.log');
    this._ensureQueueDir();
  }

  /**
   * Ensure queue directory exists
   */
  async _ensureQueueDir() {
    try {
      await fs.mkdir(this.queueDir, { recursive: true });
    } catch (err) {
      console.error('Failed to create queue directory:', err);
    }
  }

  /**
   * Add content to queue (executor interface)
   * Returns: queueId string
   */
  async add(contentData, queuedBy = 'agent') {
    const { type, title, body, metadata } = contentData;
    const content = { title, body, ...metadata };
    return await this.queue(type, content, { queuedBy, ...metadata });
  }

  /**
   * Queue content for review
   * Returns: queueId
   */
  async queue(type, content, metadata = {}) {
    const queueId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const queueItem = {
      queueId,
      type, // 'social', 'blog', 'email', 'wordpress'
      content,
      metadata,
      status: 'pending',
      queuedAt: new Date().toISOString(),
      queuedBy: this.agentName
    };

    // Write to queue file
    const queueFile = join(this.queueDir, `${queueId}.json`);
    await fs.writeFile(queueFile, JSON.stringify(queueItem, null, 2));

    // Log to audit trail
    await this._logAudit({
      type: 'CONTENT_QUEUED',
      queueId,
      contentType: type,
      preview: this._preview(content)
    });

    return queueId;
  }

  /**
   * List all pending content
   */
  async listPending() {
    await this._ensureQueueDir();
    const files = await fs.readdir(this.queueDir);
    const pending = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = join(this.queueDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const item = JSON.parse(content);
      
      if (item.status === 'pending') {
        pending.push({
          queueId: item.queueId,
          type: item.type,
          queuedAt: item.queuedAt,
          preview: this._preview(item.content),
          metadata: item.metadata
        });
      }
    }

    return pending.sort((a, b) => new Date(b.queuedAt) - new Date(a.queuedAt));
  }

  /**
   * Get full content item
   */
  async get(queueId) {
    const queueFile = join(this.queueDir, `${queueId}.json`);
    try {
      const content = await fs.readFile(queueFile, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      return null;
    }
  }

  /**
   * Approve and mark as ready to publish
   * Does NOT auto-publish - returns content for agent to execute
   */
  async approve(queueId, approvedBy = 'owner') {
    const item = await this.get(queueId);
    if (!item) {
      return { success: false, error: 'Queue item not found' };
    }

    if (item.status !== 'pending') {
      return { success: false, error: `Item already ${item.status}` };
    }

    // Update status
    item.status = 'approved';
    item.approvedAt = new Date().toISOString();
    item.approvedBy = approvedBy;

    const queueFile = join(this.queueDir, `${queueId}.json`);
    await fs.writeFile(queueFile, JSON.stringify(item, null, 2));

    await this._logAudit({
      type: 'CONTENT_APPROVED',
      queueId,
      contentType: item.type,
      approvedBy
    });

    return {
      success: true,
      message: `✅ Content approved: ${item.type}`,
      item
    };
  }

  /**
   * Reject and discard content
   */
  async reject(queueId, rejectedBy = 'owner', reason = '') {
    const item = await this.get(queueId);
    if (!item) {
      return { success: false, error: 'Queue item not found' };
    }

    // Update status
    item.status = 'rejected';
    item.rejectedAt = new Date().toISOString();
    item.rejectedBy = rejectedBy;
    item.rejectionReason = reason;

    const queueFile = join(this.queueDir, `${queueId}.json`);
    await fs.writeFile(queueFile, JSON.stringify(item, null, 2));

    await this._logAudit({
      type: 'CONTENT_REJECTED',
      queueId,
      contentType: item.type,
      rejectedBy,
      reason
    });

    return {
      success: true,
      message: `❌ Content rejected: ${item.type}`,
      item
    };
  }

  /**
   * Mark as published (after successful publish action)
   */
  async markPublished(queueId, publishDetails = {}) {
    const item = await this.get(queueId);
    if (!item) {
      return { success: false, error: 'Queue item not found' };
    }

    item.status = 'published';
    item.publishedAt = new Date().toISOString();
    item.publishDetails = publishDetails;

    const queueFile = join(this.queueDir, `${queueId}.json`);
    await fs.writeFile(queueFile, JSON.stringify(item, null, 2));

    await this._logAudit({
      type: 'CONTENT_PUBLISHED',
      queueId,
      contentType: item.type,
      publishDetails
    });

    return {
      success: true,
      message: `📤 Content published: ${item.type}`,
      item
    };
  }

  /**
   * Create content preview (first 200 chars)
   */
  _preview(content) {
    if (typeof content === 'string') {
      return content.length > 200 ? content.slice(0, 200) + '...' : content;
    }
    if (content.text || content.body) {
      const text = content.text || content.body;
      return text.length > 200 ? text.slice(0, 200) + '...' : text;
    }
    return '[Complex content - use !preview to view full]';
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

export default ContentQueue;
