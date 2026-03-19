/**
 * QuantumClaw Content Queue
 *
 * All publishing actions (social, blog, email) go here for review.
 * Nothing goes live without explicit approval.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { log } from '../core/logger.js';

export class ContentQueue {
  constructor(config) {
    this.dataDir = join(config._dir, 'content-queue');
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    
    this.queuePath = join(this.dataDir, 'queue.json');
    this._loadQueue();
  }

  _loadQueue() {
    try {
      if (existsSync(this.queuePath)) {
        this.queue = JSON.parse(readFileSync(this.queuePath, 'utf8'));
      } else {
        this.queue = { nextId: 1, items: [] };
      }
    } catch (err) {
      log.warn(`Content queue corrupt, resetting: ${err.message}`);
      this.queue = { nextId: 1, items: [] };
    }
  }

  _saveQueue() {
    writeFileSync(this.queuePath, JSON.stringify(this.queue, null, 2));
  }

  /**
   * Add content to queue (instead of publishing directly)
   * @param {Object} content - { type, platform, title, body, metadata }
   * @param {string} agent - Which agent created this
   * @returns {number} Queue item ID
   */
  add(content, agent = 'unknown') {
    const id = this.queue.nextId++;
    const item = {
      id,
      agent,
      type: content.type, // 'social_post', 'blog_post', 'email', 'youtube_metadata'
      platform: content.platform, // 'twitter', 'linkedin', 'facebook', 'wordpress', etc.
      title: content.title || '',
      body: content.body || '',
      metadata: content.metadata || {},
      status: 'pending',
      created: new Date().toISOString(),
      approved: null,
      published: null,
      approved_by: null,
    };

    this.queue.items.push(item);
    this._saveQueue();

    log.info(`📝 Content queued [${id}]: ${content.type} → ${content.platform}`);
    return id;
  }

  /**
   * Get pending items
   */
  pending() {
    return this.queue.items.filter(i => i.status === 'pending').reverse();
  }

  /**
   * Get item by ID
   */
  get(id) {
    return this.queue.items.find(i => i.id === id);
  }

  /**
   * Approve and publish content
   * @param {number} id
   * @param {string} approvedBy
   * @returns {Object} Item details for publishing
   */
  approve(id, approvedBy = 'owner') {
    const item = this.queue.items.find(i => i.id === id && i.status === 'pending');
    if (!item) {
      throw new Error(`Queue item ${id} not found or already processed`);
    }

    item.status = 'approved';
    item.approved = new Date().toISOString();
    item.approved_by = approvedBy;
    this._saveQueue();

    log.success(`✅ Content approved [${id}]: ${item.type} → ${item.platform}`);
    return item;
  }

  /**
   * Reject content
   */
  reject(id, reason = '', rejectedBy = 'owner') {
    const item = this.queue.items.find(i => i.id === id && i.status === 'pending');
    if (!item) {
      throw new Error(`Queue item ${id} not found or already processed`);
    }

    item.status = 'rejected';
    item.approved = new Date().toISOString();
    item.approved_by = rejectedBy;
    item.metadata.rejection_reason = reason;
    this._saveQueue();

    log.info(`❌ Content rejected [${id}]: ${reason}`);
  }

  /**
   * Mark as published (after actual publishing succeeds)
   */
  markPublished(id, publishResult = {}) {
    const item = this.queue.items.find(i => i.id === id);
    if (!item) return;

    item.status = 'published';
    item.published = new Date().toISOString();
    item.metadata.publish_result = publishResult;
    this._saveQueue();

    log.success(`🚀 Content published [${id}]`);
  }

  /**
   * Get recent items (all statuses)
   */
  recent(limit = 20) {
    return this.queue.items.slice(-limit).reverse();
  }

  /**
   * Archive old items (keep last 200)
   */
  cleanup() {
    if (this.queue.items.length > 200) {
      this.queue.items = this.queue.items.slice(-200);
      this._saveQueue();
      log.debug('Content queue cleaned up');
    }
  }
}
