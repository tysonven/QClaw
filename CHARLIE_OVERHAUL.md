# Charlie Overhaul

Running architecture document for Charlie 2.0. This overhaul redesigns Charlie to serve the operating model defined in `CEO_OPERATING_MODEL.md`.

## Status

- Phase 1 (Role spec + failure catalogue): COMPLETE
- Phase 2 (Code-grounded audit): COMPLETE — see /tmp/charlie_phase2_audit.md
- Phase 2.5 (CEO Operating Model spec): COMPLETE — see CEO_OPERATING_MODEL.md
- Phase 3 (Charlie 2.0 design): IN PROGRESS
- Phase 4 (Implementation): PENDING

## Failure patterns being addressed

- A: Hallucinated context
- B: Stale memory / lost state
- C: False completion reports
- D: Phantom tool use
- E: Lane violations

## Phase 2 headline finding

Charlie has been built as if he reads canonical docs at session start, but the runtime opens almost none of them. Every failure pattern is a downstream consequence of this doc-runtime gap. Phase 3 treats this as the single root cause.

## Phase 3 design — six components

1. Bootstrap mechanism
2. Canonical doc loading
3. Skill loading strategy (pragmatic split, upgradeable interface)
4. Tool surface overhaul
5. Verification gates (soft + hard)
6. Claude Code delegation bridge

(Designs to be appended as each is locked.)
