# Fix Plan: Make Agent Skills Executable

## Problem
Agent skills (stripe.md, ghl.md, etc.) are loaded as text and shown in system prompt, but NOT registered as executable tools in the ToolRegistry.

## Solution
Add a method to ToolRegistry that converts skill markdown into executable API tools:

### Changes needed:

1. **ToolRegistry.registerAgentSkills(skills, secrets)**
   - Parse skill markdown to extract API definitions
   - Convert into tool definitions
   - Register them like PRESET_SERVERS API tools

2. **Agent.process() — wire skills into ToolRegistry**
   - After loading skills in Agent.load()
   - Pass them to toolExecutor registry during initialization

3. **Skill format detection**
   - If skill has "Base URL:" and "Endpoints:" → treat as API skill
   - Parse endpoints into tool definitions
   - Wire {{secrets.key}} replacement

## Files to modify:
- `/Users/tysonvenables/QClaw/src/tools/registry.js` — add registerAgentSkills()
- `/Users/tysonvenables/QClaw/src/agents/registry.js` — wire skills to toolExecutor

## Implementation:

### Step 1: Add to ToolRegistry
```javascript
/**
 * Register agent skills as executable API tools
 */
async registerAgentSkills(skills) {
  for (const skill of skills) {
    if (!skill.content) continue;
    
    // Parse skill markdown
    const parsed = this._parseSkillMarkdown(skill.content);
    if (!parsed.baseUrl || !parsed.endpoints || parsed.endpoints.length === 0) {
      continue; // Not an API skill
    }
    
    // Register each endpoint as a tool
    for (const endpoint of parsed.endpoints) {
      const toolName = `${skill.name}__${endpoint.name}`;
      this._apiTools.set(toolName, {
        preset: {
          name: skill.name,
          baseUrl: parsed.baseUrl,
          headers: parsed.headers || {},
          secretKey: parsed.secretKey
        },
        toolDef: {
          name: endpoint.name,
          description: endpoint.description,
          method: endpoint.method,
          path: endpoint.path,
          inputSchema: endpoint.inputSchema || { type: 'object', properties: {} }
        }
      });
    }
  }
}

_parseSkillMarkdown(content) {
  const result = {
    baseUrl: null,
    headers: {},
    secretKey: null,
    endpoints: []
  };
  
  const lines = content.split('\n');
  let section = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Detect sections
    if (trimmed === '## Auth') { section = 'auth'; continue; }
    if (trimmed === '## Endpoints') { section = 'endpoints'; continue; }
    if (trimmed.startsWith('##')) { section = null; continue; }
    
    // Parse auth section
    if (section === 'auth') {
      if (trimmed.startsWith('Base URL:')) {
        result.baseUrl = trimmed.split('Base URL:')[1].trim();
      }
      if (trimmed.startsWith('Header:')) {
        const headerLine = trimmed.split('Header:')[1].trim();
        const parts = headerLine.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join(':').trim();
          result.headers[key] = value;
          
          // Extract secret key if present
          const secretMatch = value.match(/\{\{secrets\.([^}]+)\}\}/);
          if (secretMatch) {
            result.secretKey = secretMatch[1];
          }
        }
      }
    }
    
    // Parse endpoints section
    if (section === 'endpoints') {
      const match = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s*[-–]?\s*(.*)/);
      if (match) {
        const method = match[1];
        const path = match[2];
        const description = match[3] || '';
        
        // Generate tool name from path
        const toolName = path
          .replace(/^\//, '')
          .replace(/\//g, '_')
          .replace(/\{[^}]+\}/g, 'by_id')
          .replace(/[^a-z0-9_]/gi, '_')
          .toLowerCase();
        
        result.endpoints.push({
          name: toolName,
          description,
          method,
          path,
          inputSchema: { type: 'object', properties: {} }
        });
      }
    }
  }
  
  return result;
}
```

### Step 2: Wire into Agent.process()

In `registry.js` Agent class, after `await agent.load()`:

```javascript
// In AgentRegistry.loadAll() after agent.load():
if (this.services.toolExecutor && agent.skills.length > 0) {
  await this.services.toolExecutor.registry.registerAgentSkills(agent.skills);
}
```

## Result
- `show stripe customers` → executes `stripe__list_customers` tool
- `recent ghl contacts` → executes `ghl__search_contacts` tool
- All skill-based APIs become executable, not just documentation
