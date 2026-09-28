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

export * from "#baseline"
export * from "#check"
export * from "#comment/triage/inventory"
export * from "#context"
export * from "#fix"
export * from "#fixes"
export * from "#move/apply"
export * from "#move/plan"
export * from "#move/types"
export * from "#registry"
