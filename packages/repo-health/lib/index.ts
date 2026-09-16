/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Repository health checks as a registry. See `registry.ts` for the entry point and `check.ts` for the shape.
 *
 *   Three exports here are not checks and are never registered as one. `baseline.ts` writes the debt baseline for
 *   `mwops health baseline debt`. `fixes.ts` lists the checks whose diagnostics have a mechanical repair, and
 *   `move/` plans and applies it for `mwops health fix <check>`; planning reads, and only `applyModuleMoves` writes.
 *   `comment/triage/inventory.ts` rebuilds the source-comment inventory for `mwops health comments` — an inventory
 *   rather than a verdict, which is why it answers a report and not a diagnostic list.
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
