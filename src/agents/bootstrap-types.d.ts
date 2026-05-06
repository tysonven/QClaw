/**
 * BootstrapResult — type contract for src/agents/bootstrap.js.
 *
 * QClaw is a Node.js project without TypeScript compilation; this file is
 * documentation-as-code so future readers can see the shape at a glance.
 * Consumers do not import this file — runtime code uses plain JS objects.
 */

export interface ProbeResult {
  name: 'n8n_reachable' | 'heartbeat_freshness' | 'pm2_processes' | 'supabase_reachable' | 'memory_layer';
  ok: boolean;
  latency_ms: number;
  detail?: unknown;
  error?: string;
}

export interface BootstrapResult {
  agent_name: string;
  user_id: number | string | null;
  loaded_at: string;             // ISO 8601
  cache_key: string;             // `${user_id}:${agent_name}`

  identity: {
    soul: string | null;
    values: string | null;
    identity_doc: string | null;
    ceo_operating_model: string | null;
    charlie_role: string | null;
  };

  state: {
    flow_os_state: string | null;
    recent_build_log: string | null;     // last 7 days of QCLAW_BUILD_LOG.md, capped to 50 entries
  };

  specialists: {
    flow_os_specialists: string | null;
  };

  recent: {
    memory: {
      source: 'cognee' | 'vector' | 'sqlite' | 'unavailable';
      entries: Array<{ role?: string; content?: string; timestamp?: string }>;
    };
    audit_log: {
      source: 'sqlite' | 'jsonl' | 'unavailable';
      entries: Array<Record<string, unknown>>;
    };
  };

  probes: ProbeResult[];

  warnings: string[];
}
