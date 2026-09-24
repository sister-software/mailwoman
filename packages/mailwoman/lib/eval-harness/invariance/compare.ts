/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare decoded component maps without loading a model or data.
 *   Critical-tag changes or hallucinations are `LOST`; other component drift is `DEGRADED`.
 *   Equal maps are `INVARIANT`. Map order does not affect the result.
 */

/**
 * Tags whose changes produce a `LOST` verdict.
 */
export const CRITICAL_TAGS = ["house_number", "street", "postcode"] as const

export type Verdict = "INVARIANT" | "DEGRADED" | "LOST"

/**
 * Severity order used to compare candidate and baseline verdicts.
 */
export const VERDICT_SEVERITY: Record<Verdict, number> = { INVARIANT: 0, DEGRADED: 1, LOST: 2 }

export interface CompareResult {
	verdict: Verdict
	/**
	 * Human-readable per-tag diff lines, empty for invariant.
	 */
	diff: string[]
}

/**
 * Normalize a component value for comparison: trim, lowercase, collapse internal whitespace.
 *
 * Non-string/empty → "".
 */
function normVal(v: unknown): string {
	if (typeof v !== "string") return ""

	return v.trim().toLowerCase().replaceAll(/\s+/g, " ")
}

/**
 * Compare a baseline (`original`) component map against a perturbed (`transformed`) one.
 *
 * Order-insensitive by construction.
 * Both are plain key→value records.
 */
export function compareComponents(
	original: Record<string, string>,
	transformed: Record<string, string>
): CompareResult {
	const originalKeys = Object.keys(original).filter((k) => normVal(original[k]))
	const transformedKeys = Object.keys(transformed).filter((k) => normVal(transformed[k]))

	// The `lost` verdict: the transformed parse is empty (or all-blank)
	// while the original had components at all.
	// "unresolvable-shaped": a fully collapsed decode, the parse-level analog of a
	// resolver falling back to an admin-only tier with no coordinate.
	if (!transformedKeys.length && originalKeys.length) {
		return { verdict: "LOST", diff: ["transformed parse is empty"] }
	}

	const diff: string[] = []
	let criticalBroken = false

	for (const tag of CRITICAL_TAGS) {
		const o = normVal(original[tag])
		const t = normVal(transformed[tag])

		if (!o) {
			// Not present in the original.
			// A hallucinated value on the transformed side still yields the `lost` verdict.
			// See the header doc comment (a wrong-but-confident rooftop is worse than a graceful fallback).
			if (t) {
				criticalBroken = true
				diff.push(`${tag}: ∅ → "${transformed[tag]}" (hallucinated)`)
			}

			continue
		}

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

	return diff.length ? { verdict: "DEGRADED", diff } : { verdict: "INVARIANT", diff: [] }
}
