---
name: autopilot
description: Keep the current branch merge-ready. Fix conflicts, review comments, then CI.
---
# Autopilot

Get this branch merge-ready: mergeable, checks green, review comments triaged.

Refresh git status at the start of every pass. Work in this order only:
1. Merge conflicts.
2. Unresolved review comments.
3. Failing checks.

Read the failing check output before changing code. Do not weaken CI config to make a check pass. Do not start CI work while a conflict is unresolved. If nothing is actionable, say what is still running.
