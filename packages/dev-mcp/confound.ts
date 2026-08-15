/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What actually differs between two arms, versus what the caller said differs.
 *
 *   This mechanizes a hazard the repo already documents rather than inventing a rule.
 *   `docs/engineering/reference/resolver-backends.mdx` states it outright: *"Any comparison between backends must pin
 *   `--country-scope` to `locale` or `none` across both arms, or run the full 2×2."* Under the default
 *   `--country-scope auto`, switching backend ALSO switches country scoping, and that document's own table shows
 *   `12 Rue de Rivoli, 75001 Paris` landing in Texas or in France depending on which of the two variables actually
 *   moved. A caller declaring `variable: ["backend"]` in that situation is measuring two things and attributing the
 *   result to one.
 *
 *   Comparing STATED configs cannot see this; comparing EFFECTIVE configs can, which is why
 *   {@link EngineRegistry.acquire} resolves defaults before anything here reads them.
 *
 *   **It warns, it does not refuse** (decided 2026-08-16, spec §6.3). An earlier draft made an undeclared difference a
 *   hard error. The reasoning that overturned it: a refusal an agent cannot override is a reason to bypass the tool
 *   and run the comparison in a shell, where there is no guard at all. A warning that travels inside `summary`
 *   survives the relay; a refusal only helps if the agent stays inside the tool.
 */

/**
 * How confidently a delta can be assigned to the declared variable.
 */
export const Attribution = {
	/**
	 * Exactly the declared keys differ. The delta belongs to the variable.
	 */
	Clean: "clean",
	/**
	 * More keys moved than were declared, so the delta belongs to some combination of them.
	 */
	Ambiguous: "ambiguous",
	/**
	 * The arms are configured identically. Any difference between them comes from somewhere this record cannot see —
	 * nondeterminism, external state — which is worth knowing before reading a delta as a finding.
	 */
	NoVariable: "no_variable",
} as const

export type Attribution = (typeof Attribution)[keyof typeof Attribution]

export interface ConfoundReading {
	attribution: Attribution
	/**
	 * Every key that actually differs, whether or not it was declared. This is the field to read; `variable` as passed is
	 * the caller's claim, not a finding.
	 */
	variable_effective: string[]
	declared: string[]
	/**
	 * Declared but identical across the arms — usually a typo in the declaration, occasionally a lever that silently
	 * resolved to the same default in both arms, which is itself worth seeing.
	 */
	declared_but_unmoved: string[]
	/**
	 * Moved without being declared. These are the keys the delta cannot be pinned on.
	 */
	moved_but_undeclared: string[]
	warnings: string[]
}

function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])

	return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).toSorted()
}

/**
 * Compare two effective configurations against the caller's declaration.
 */
export function checkConfounds(
	effectiveA: Record<string, unknown>,
	effectiveB: Record<string, unknown>,
	declared: string[]
): ConfoundReading {
	const moved = differingKeys(effectiveA, effectiveB)
	const declaredSet = new Set(declared)
	const movedSet = new Set(moved)

	const movedButUndeclared = moved.filter((key) => !declaredSet.has(key))
	const declaredButUnmoved = declared.filter((key) => !movedSet.has(key)).toSorted()
	const warnings: string[] = []

	if (movedButUndeclared.length) {
		warnings.push(
			`Undeclared differences: ${movedButUndeclared.join(", ")}. The delta cannot be attributed to ` +
				`${declared.length ? declared.join(", ") : "any single lever"} alone — these moved too. ` +
				`Either pin them across both arms, or declare them and read the result as a 1×2 slice of a 2×2.`
		)
	}

	if (declaredButUnmoved.length) {
		warnings.push(
			`Declared but identical in both arms: ${declaredButUnmoved.join(", ")}. ` +
				`Either the declaration is wrong or both arms resolved that lever to the same default.`
		)
	}

	if (!moved.length) {
		warnings.push(
			"The two arms have identical effective configurations. Any difference between them comes from outside this " +
				"record — nondeterminism or external state — not from a lever."
		)
	}

	const attribution: Attribution = !moved.length
		? Attribution.NoVariable
		: movedButUndeclared.length
			? Attribution.Ambiguous
			: Attribution.Clean

	return {
		attribution,
		variable_effective: moved,
		declared: [...declared].toSorted(),
		declared_but_unmoved: declaredButUnmoved,
		moved_but_undeclared: movedButUndeclared,
		warnings,
	}
}

/**
 * Fields that must never be compared across backends, with the reason.
 *
 * `resolver_score` is bm25-derived on FTS (≈19–41) and population-derived on the candidate table (≈5–7), so a
 * cross-backend comparison of it is a unit error wearing a number. Worse, `resolver-backends.mdx:162-170` measured that
 * WITHIN either backend the wrong answers' score range sits inside the correct answers' range with a HIGHER mean — so
 * it cannot be thresholded on either, which is why this is a refusal rather than a warning.
 */
export const INCOMPARABLE_FIELDS = new Set(["resolver_score", "score", "prominence"])

export function assertComparableField(field: string): void {
	if (INCOMPARABLE_FIELDS.has(field)) {
		throw new Error(
			`Field ${JSON.stringify(field)} is not comparable. It is scored on different scales by different backends ` +
				`(bm25 ≈19–41 on FTS, population ≈5–7 on candidate), and within either backend the wrong answers' range ` +
				`sits inside the correct answers' range with a higher mean. There is no threshold on it that means anything.`
		)
	}
}
