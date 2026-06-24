/**
 * Slice 6c — specialist skill loader.
 *
 * Registers a specialist agent's skill tools under the specialist's OWN
 * agentName (scope principal isolation), reading the canonical SSOT at
 * src/agents/skills/ — NEVER the stale runtime symlink dir
 * (~/.quantumclaw/workspace/agents/charlie/skills/, audit F10).
 *
 * Behaviour per skill slug (from the SpecialistEntry.skills array):
 *   - File missing  → warn + skip (live-specialist skill wiring is 6d's job;
 *                      stubs with unresolved name-derived slugs are expected).
 *   - File exists    → push { name, content } to specialist.skills (so the
 *                      dashboard skill count is real), AND register HTTP tools
 *                      iff parseSkill() returns non-null (HTTP skills only —
 *                      parseSkill requires Base URL + Endpoints; prompt-surface
 *                      skills parse to null and contribute content but no tools,
 *                      audit A2).
 *
 * Tool registration goes through ToolRegistry.registerSkillTool(agentName, …),
 * which scopes the tool to [agentName] — so a specialist's tools are isolated
 * to that specialist, not shared and not charlie's (audit F9).
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { log } from '../core/logger.js';
import { parseSkill, skillToTools } from './skill-parser.js';
import { getSpecialist } from './specialist-registry.js';

// Canonical SSOT — identical resolution to skill-loader.js SKILLS_DIR. This
// module lives in src/agents/, so '../..' is the repo root.
export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'agents', 'skills');

/**
 * Register a specialist's skill tools off the SSOT.
 *
 * @param {Agent}  specialist  an Agent built via Agent.createSpecialist()
 * @param {object} services    AgentRegistry services bag ({ toolRegistry, secrets, … })
 * @param {object} [opts]       test seam — { skillsDir, getEntry }
 * @returns {void}
 */
export function registerSpecialistSkills(specialist, services, opts = {}) {
  const skillsDir = opts.skillsDir || SKILLS_DIR;
  const lookupEntry = opts.getEntry || getSpecialist;
  const toolRegistry = services?.toolRegistry || null;
  const secrets = services?.secrets || null;

  const entry = lookupEntry(specialist.name);
  const slugs = (entry && Array.isArray(entry.skills)) ? entry.skills : [];

  for (const slug of slugs) {
    const filepath = join(skillsDir, `${slug}.md`);
    if (!existsSync(filepath)) {
      log.warn(
        `registerSpecialistSkills: skill '${slug}' for ${specialist.name} not found at ${filepath} ` +
        `— skipping (live specialist skills wired in 6d)`
      );
      continue;
    }

    const raw = readFileSync(filepath, 'utf-8');
    // Always record the skill on the agent — drives agent.skills.length in /api/agents.
    specialist.skills.push({ name: slug, content: raw });

    // HTTP-tool registration only when the file parses as an HTTP skill
    // (parseSkill returns null for prompt-surface skills — no baseUrl/endpoints).
    const parsed = parseSkill(slug, raw, secrets);
    if (parsed && toolRegistry && typeof toolRegistry.registerSkillTool === 'function') {
      const tools = skillToTools(parsed);
      for (const toolDef of tools) {
        toolRegistry.registerSkillTool(specialist.name, slug, parsed, toolDef);
      }
      if (tools.length) {
        log.debug(
          `registerSpecialistSkills: ${specialist.name} ${slug} → ${tools.length} HTTP tools (scope: ${specialist.name})`
        );
      }
    }
  }
}
