/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Component-level comparison for the invariance mini-suite — pure, no model, no I/O. Compares two
 *   decoded component maps (order-insensitive: a plain key→value record has no order) and classifies the
 *   pair INVARIANT / DEGRADED / LOST.
 *
 *   `house_number` / `street` / `postcode` are treated as CRITICAL: they're the load-bearing tags a
 *   downstream geocoder needs to resolve a rooftop (the same three the #251/#1101 DIR-test failures broke
 *   on). A value change on a critical tag that's present in the original — including one token bleeding
 *   from a neighboring tag, e.g. a stripped comma pulling a directional suffix into the locality — is LOST
 *   even when the transformed parse is non-empty, because the address is no longer resolvable to the same
 *   place. A drift confined to non-critical tags (locality, region, dependent_locality, unit, …) is
 *   DEGRADED: recoverable, worth flagging, not ship-blocking on its own.
 */

export const CRITICAL_TAGS = ["house_number", "street", "postcode"] as const

export type Verdict = "INVARIANT" | "DEGRADED" | "LOST"

export interface CompareResult {
	verdict: Verdict
	/** Human-readable per-tag diff lines, empty for INVARIANT. */
	diff: string[]
}

/** Normalize a component value for comparison: trim, lowercase, collapse internal whitespace. Non-string/empty → "". */
function normVal(v: unknown): string {
	if (typeof v !== "string") return ""

	return v.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Compare a baseline (`original`) component map against a perturbed (`transformed`) one. Order-insensitive by
 * construction — both are plain key→value records.
 */
export function compareComponents(
	original: Record<string, string>,
	transformed: Record<string, string>
): CompareResult {
	const originalKeys = Object.keys(original).filter((k) => normVal(original[k]))
	const transformedKeys = Object.keys(transformed).filter((k) => normVal(transformed[k]))

	// LOST — the transformed parse is empty (or all-blank) while the original had components at all.
	// "unresolvable-shaped": a fully collapsed decode, the parse-level analog of a resolver falling back
	// to an admin-only tier with no coordinate.
	if (transformedKeys.length === 0 && originalKeys.length > 0) {
		return { verdict: "LOST", diff: ["transformed parse is empty"] }
	}

	const diff: string[] = []
	let criticalBroken = false

	for (const tag of CRITICAL_TAGS) {
		const o = normVal(original[tag])

		if (!o) continue // tag not present in the original — nothing critical to protect here.
		const t = normVal(transformed[tag])

		if (o !== t) {
			criticalBroken = true
			diff.push(`${tag}: "${original[tag]}" → "${transformed[tag] ?? "∅"}"`)
		}
	}

	if (criticalBroken) return { verdict: "LOST", diff }

	// Non-critical drift: any key added/dropped, or any shared key's value changed.
	const allKeys = new Set([...originalKeys, ...transformedKeys, ...Object.keys(transformed), ...Object.keys(original)])

	for (const tag of allKeys) {
		const o = normVal(original[tag])
		const t = normVal(transformed[tag])

		if (o !== t) {
			diff.push(`${tag}: "${original[tag] ?? "∅"}" → "${transformed[tag] ?? "∅"}"`)
		}
	}

	return diff.length > 0 ? { verdict: "DEGRADED", diff } : { verdict: "INVARIANT", diff: [] }
}
