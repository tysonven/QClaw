# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Email security@allin1.app with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Security Architecture

QuantumClaw takes security seriously at every layer:

- **Secrets**: AES-256-GCM encryption at rest, machine-specific derived keys
- **Trust Kernel**: Immutable VALUES.md rules the agent cannot override
- **Audit Trail**: Every agent action logged with timestamps and cost tracking
- **AGEX Protocol**: Autonomous credential lifecycle with automatic rotation, scoped delegation, and emergency revocation in under 60 seconds
- **Exec Approvals**: Destructive operations require human sign-off
- **Channel Allowlists**: Only authorised users can interact with your agent

### Claude Code delegation (Phase 4 Slice 5) — 7-Pillars gate

The dispatcher runs an untrusted-brief-driven second agent (Claude Code), so it is gated structurally, not by prompt:

- **Dispatch table RLS**: `claude_code_dispatches` has RLS **ENABLED + FORCED**, all grants **REVOKED** from `anon`/`authenticated` — `service_role` only; SECURITY DEFINER RPCs restricted to `service_role`.
- **Unprivileged execution**: Claude Code runs as the `ccdispatch` system user (**never root**), in a throwaway clone, with a scrubbed child env. **Kernel file-permissions** — not a denylist — prevent it reading `/root/.quantumclaw/*`, SSH keys, or other processes' `/proc/<pid>/environ` (proven by the pause-(c) secret-read matrix: kernel EACCES through live CC; zero leaks). The `--settings` deny-list + plan-mode are defence-in-depth only. Dispatcher refuses to run if `ccdispatch` is absent.
- **Structural scope gate**: the dispatcher independently validates `scope ∈ {audit, read_only}` before invoking CC; `write`/`infra`/`critical` rows are rejected to `failed` (fail-closed) regardless of how they reached the table.
- **Service-role credential handling**: creds read from `/root/.quantumclaw/.env` (mode 600); the in-app tool/read-path read via `core/env.js getEnv()` (not `process.env`).
- **Secrets-dir hardening (2026-06-18)**: `/root/.quantumclaw` tightened `755→750` and its files `644→600`, closing a pre-existing world-readable leak of `config.json` (dashboard authToken) and the memory/audit DBs.
- **Output scrubbing**: CC result text is secret-scrubbed (API-key/JWT/known-value redaction) before write-back/surfacing, and fenced as untrusted when surfaced to Charlie.
- **Read-only contract backstop**: post-run `git status` (run as `ccdispatch`, fail-safe-to-dirty) rejects any working-tree mutation under a read-only scope.

## Known Limitations

- The self-signed development AID (`ia_signature: 'self-signed-dev-not-for-production'`) is for local development only. Production deployments should use a certified AGEX Identity Authority.
- The local dashboard binds to `localhost` by default. Do not expose it to the internet without authentication.
- The completion cache stores prompt hashes, not plaintext prompts, but cache entries could theoretically reveal usage patterns.

## Acknowledgements

We appreciate responsible security researchers. Contributors who report valid vulnerabilities will be credited (with permission) in our changelog.
