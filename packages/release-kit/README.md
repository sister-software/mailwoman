# @mailwoman/release-kit

Private. The release pipeline as a registry of operations — preflight, prepare, pack, verify, stage, publish, weights
materialization, SBOM — each with an id, a declared effect (`read`, `local-write`, `external-write`), typed input and
output, and a `run`.

Nothing here is executed as a file. The private `mwops` CLI (`@mailwoman/ops-cli`) and the release MCP server are
views over `lib/registry.ts`; CI calls `mwops release <operation>`. Publishing is plan → execute: `release.plan`
returns a digest over HEAD, version, packages, artifacts and destinations, and `release.publish` recomputes it and
refuses a dirty or moved HEAD or a changed plan.

Admission rule: an operation participates in the construction, verification, staging, or publication of a release
artifact. Anything else does not belong here.

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
