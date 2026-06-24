---
name: specialist-observation
category: specialist-scope
surface: prompt
tools: [read_file, grep_repo, list_dir, git_status]
description: >
  Read-only codebase observation tools for specialist agents.
  Scoped per specialist — shell_exec is not available to specialists.
---

# Specialist Observation

Specialists observe the codebase through four typed, read-only tools. These
replace ad-hoc `shell_exec` for observation tasks — `shell_exec` is Charlie's
surface, not a specialist's. Every tool is path-bounded and side-effect free:
no writes, no shell, no path escape.

## Tools

- **`read_file(path)`** → `{ content, path, lines }`
  Read one source or doc file. `path` must resolve under the repo `src/` or
  `docs/` directories (repo-relative or absolute). Anything outside is rejected.

- **`grep_repo(pattern, dir?)`** → `{ matches: [{ file, line, content }] }`
  Search file contents under `src/`/`docs/` for `pattern` (a literal string or
  simple regex). `dir` defaults to `src/`. Shell metacharacters in the pattern
  are rejected. Results are capped.

- **`list_dir(path)`** → `{ entries: [{ name, type, size }] }`
  List a directory anywhere under the repo root. Names, types, and sizes only —
  no file contents.

- **`git_status()`** → `{ branch, clean, changes: [{ status, file }] }`
  Working-tree state of the repo. Takes no path argument — always the repo.

## Rules

- Use these for any "what does the code look like / what changed" question.
- Do **not** request `shell_exec` — it is out of specialist scope and will not
  resolve. If you need a write, a non-observation shell verb, or a path outside
  `src/`/`docs/`, that is Charlie's lane (Charlie routes it via
  `claude_code_dispatch`).
