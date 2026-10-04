/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Repository health checks as a registry. See `registry.ts` for the entry point and `check.ts` for the shape.
 *
 *   Three exports here are utilities rather than checks, so the registry never registers them.
 *   `baseline.ts` writes the debt baseline for `mwops health baseline debt`.
 *   `fixes.ts` lists checks with mechanical diagnostic repairs.
 *   `move/` plans and applies moves for `mwops health fix <check>`. The planner reads files.
 *   `applyModuleMoves` applies the writes. `comment/triage/inventory.ts` rebuilds the
 *   source-comment inventory for `mwops health comments`. That command reports inventory data
 *   and leaves verdicts and diagnostics to other checks.
 */

export * from "#repo-health/baseline"
export * from "#repo-health/check"
export * from "#repo-health/comment/triage/inventory"
export * from "#repo-health/context"
export * from "#repo-health/fix"
export * from "#repo-health/fixes"
export * from "#repo-health/move/apply"
export * from "#repo-health/move/plan"
export * from "#repo-health/move/types"
export * from "#repo-health/registry"
