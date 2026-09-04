# @mailwoman/repo-health

Private. Repository health checks as a registry: each check inspects the checkout and returns diagnostics or
pass/fail. `mwops health <id>` runs one; `mwops health all` runs the registry.

Admission rule: a check inspects and reports. No mutation, generation, publishing, benchmark, probe, or one-shot
migration lives here — a check that wants to write something is a release operation or a CLI command, not a check.

`lib/registry.ts` is the package's only executable entry point. A check file that is not registered is dead code and
knip reports it.

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
