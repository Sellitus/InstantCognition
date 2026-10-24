---
schema: clarity.policy/v1
pr:
  require_checks: true
require_before:
  pr.merge:
    - pr.checks_green
---

# Auto-merge policy

Merges wait for the repository's checks. A pull request merges only after its
checks pass on the exact commit being merged: `pr.checks_green` under
`require_before.pr.merge` enforces that, and `pr.require_checks: true` makes
green checks a condition of every merge.
