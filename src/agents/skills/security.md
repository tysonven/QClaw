---
# Security Agent — QClaw

## MANDATORY: Every build session must end with a security pass

### Rules that apply to ALL agents and Claude Code sessions:

1. NEVER hardcode API keys, tokens, or secrets in:
   - n8n workflow JSON
   - Source code files
   - Dashboard HTML/JS
   - Git commits
   
2. ALWAYS use:
   - n8n credential store for n8n workflows
   - Environment variables (.env) for server code
   - ~/.quantumclaw/.env on ssh qclaw for server secrets

3. EVERY new webhook endpoint must have authentication:
   - Minimum: x-api-key header check against env variable
   - Trading/financial endpoints: require signed request

4. EVERY new server endpoint must have rate limiting

5. NEVER commit .env files to git (verify .gitignore)

6. After any build session, run this checklist:
   - [ ] No hardcoded credentials in new/modified workflows
   - [ ] New webhook endpoints have auth headers
   - [ ] New endpoints have rate limiting
   - [ ] .env not in git
   - [ ] Sensitive files have 600 permissions

### Security review command
Charlie can trigger a security review by saying:
"Run security audit" — this checks recent workflow changes
and server config for common issues.

---
