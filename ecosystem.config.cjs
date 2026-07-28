// PM2 process definitions.
//
// Scope: trade-engine only. The five processes already running on this host
// (agex-hub, trading-worker, quantumclaw, clipper-worker,
// claude-code-dispatcher) were each started ad-hoc via the PM2 CLI and are
// managed through ~/.pm2/dump.pm2. They are deliberately NOT reconstructed
// here — reconstructed definitions would risk changing their behaviour on the
// next restart. Backfilling them is a separate piece of work.
//
// No `env_file` entry: it does not work on this host. PM2 6.0.14 does not
// inject /root/.quantumclaw/.env into child processes (verified with a probe
// process that saw neither SUPABASE_URL nor ANTHROPIC_API_KEY, and confirmed
// against the live trading-worker process environment). The trade engine loads
// that file itself via python-dotenv in src/trade_engine/config.py, matching
// what src/trading/execute_trade.py already does.

module.exports = {
  apps: [
    {
      name: 'trade-engine',
      script: 'src/trade_engine/main.py',
      interpreter: 'python3',
      cwd: '/root/QClaw',
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      env: {
        PYTHONUNBUFFERED: '1',
      },
    },
  ],
}
