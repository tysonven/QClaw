#!/usr/bin/env node

import { join } from 'path';
import { homedir } from 'os';
import { SecretStore } from './src/security/secrets.js';
import { loadConfig } from './src/core/config.js';
import { AgentRegistry } from './src/agents/registry.js';
import { ModelRouter } from './src/models/router.js';
import { MemoryManager } from './src/memory/manager.js';
import { SkillLoader } from './src/skills/loader.js';
import { ToolRegistry } from './src/tools/registry.js';
import { ToolExecutor } from './src/tools/executor.js';
import ApprovalGates from './src/security/approvalGates.js';
import RateLimiter from './src/security/rateLimiter.js';
import ContentQueue from './src/security/contentQueue.js';
import { ExecApprovals } from './src/security/approvals.js';
import { TrustKernel } from './src/security/trust-kernel.js';
import { AuditLog } from './src/security/audit.js';
import { log } from './src/core/logger.js';

async function main() {
  log.info('🧪 Testing Approval Ga System\n');

  const config = await loadConfig();
  const secrets = new SecretStore(config);
  await secrets.load();

  const memory = new MemoryManager(config, secrets);
  await memory.connect();

  const router = new ModelRouter(config, secrets);
  const skills = new SkillLoader(config);
  await skills.loadAll();

  const trustKernel = new TrustKernel(config);
  await trustKernel.load();

  const audit = new AuditLog(config);
  const approvals = new ExecApprovals(config);
  approvals.attach(null);

  // Initialize tool system
  const toolRegistry = new ToolRegistry(config, secrets);
  await toolRegistry.init();

  const approvalGate = new ApprovalGates('charlie', join(config._dir, 'workspace'));
  const rateLimiter = new RateLimiter('charlie', join(config._dir, 'workspace'), {
    stripe: 100,
    ghl: 200,
    'n8n-router': 50
  });
  const contentQueue = new ContentQueue('charlie', join(config._dir, 'workspace'));

  const toolExecutor = new ToolExecutor(router, toolRegistry, {
    requireApproval: config.tools?.requireApproval || ['shell', 'file_write'],
    approvalGate,
    rateLimiter,
    contentQueue,
    onToolCall: (call) => {
      log.debug(`Tool: ${call.name}`);
      audit.log('tool', call.name, JSON.stringify(call.args).slice(0, 200));
    },
  });

  const agents = new AgentRegistry(config, {
    memory,
    router,
    skills,
    trustKernel,
    audit,
    secrets,
    config,
    approvals,
    toolRegistry,
    toolExecutor
  });
  await agents.loadAll();

  const charlie = agents.get('charlie') || agents.primary();
  if (!charlie) {
    log.error('❌ Charlie not found');
    process.exit(1);
  }

  log.info('✅ Charlie loaded\n');

  // Test 1: Simple greeting (reflex tier)
  log.info('--- Test 1: Reflex Response ---');
  const greeting = await charlie.process('hello', {
    channel: 'test',
    threadId: 'test-001',
    userId: 'tyson',
    username: 'Tyson'
  });
  log.info(`Response: ${greeting.text || JSON.stringify(greeting, null, 2)}\n`);

  // Test 2: Stripe skill call (should execute tool)
  log.info('--- Test 2: St API Call ---');
  try {
    const stripeQuery = await charlie.process('show me the last 5 stripe customers', {
      channel: 'test',
      threadId: 'test-002',
      userId: 'tyson',
      username: 'Tyson'
    });
    log.info(`Response: ${stripeQuery.text || JSON.stringify(stripeQuery, null, 2)}\n`);
  } catch (error) {
    log.error(`Error: ${error.message}\n`);
  }

  log.info('✅ Test Complete');
  process.exit(0);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
