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

import { execFileSync } from "@mailwoman/platform/child_process"

import { effectiveKeyFor } from "./engine-registry.ts"

/**
 * Whether the comparison's SETUP was clean — did exactly the declared keys differ between the two resolved configs.
 *
 * Read this as a hygiene check on the experiment, never as a causal finding. It compares two config objects; it has no
 * access to why any individual row moved, and a delta is a property of an aggregate while causation happens per row
 * through a mechanism. A `clean` here licenses the sentence "nothing else in the configuration moved" and nothing
 * stronger. Diagnosis needs the per-row interior, which this file does not have and `mwdev_trace` does.
 */
export const VariableIsolation = {
	/**
	 * Exactly the declared keys differ. Nothing else in the configuration moved.
	 */
	Clean: "clean",
	/**
	 * More keys moved than were declared, so the configuration cannot isolate the declared one.
	 */
	Ambiguous: "ambiguous",
	/**
	 * The arms are configured identically. Any difference between them comes from somewhere this record cannot see —
	 * nondeterminism, external state — which is worth knowing before reading a delta as a finding.
	 */
	NoVariable: "no_variable",
	/**
	 * The arms are different geocoders. No configuration record can express what differs, because the dominant variable
	 * is the INDEX each one holds — and no configuration record can isolate a lever here, however carefully declared.
	 */
	CrossEngine: "cross_engine",
} as const

export type VariableIsolation = (typeof VariableIsolation)[keyof typeof VariableIsolation]

export interface ConfoundReading {
	variable_isolation: VariableIsolation
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
	// Declared keys arrive in the CLI's snake_case (the vocabulary the tool schema documents); `effective*` keys are
	// camelCase. Compared raw, one correctly-declared lever reads as TWO findings — declared-but-unmoved under one
	// spelling, moved-but-undeclared under the other — and every honest single-lever comparison grades itself ambiguous.
	const declaredSet = new Set(declared.map(effectiveKeyFor))
	const movedSet = new Set(moved)

	const movedButUndeclared = moved.filter((key) => !declaredSet.has(key))
	// Filtered on the translated key, reported in the caller's own spelling — they typed `place_country`, and telling
	// them `placeCountry` is unmoved names a key they never wrote.
	const declaredButUnmoved = declared.filter((key) => !movedSet.has(effectiveKeyFor(key))).toSorted()
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

	const isolation: VariableIsolation = !moved.length
		? VariableIsolation.NoVariable
		: movedButUndeclared.length
			? VariableIsolation.Ambiguous
			: VariableIsolation.Clean

	return {
		variable_isolation: isolation,
		variable_effective: moved,
		declared: [...declared].toSorted(),
		declared_but_unmoved: declaredButUnmoved,
		moved_but_undeclared: movedButUndeclared,
		warnings,
	}
}

/**
 * The reading for a comparison whose two arms are different geocoders.
 *
 * {@link checkConfounds} is the wrong instrument here and would be actively misleading if pointed at this case. Its
 * question is "did more config keys move than the caller declared", and across engines the answer is a list of keys one
 * arm does not have — every mailwoman lever against an endpoint and a version string. A reader would get a paragraph of
 * true, useless warnings, and paragraphs of those train a reader to skip the field.
 *
 * What is actually true is shorter and worse: the arms hold different indexes built from different sources at different
 * vintages, and no record either arm can produce says by how much. The panel comparator in the benchmark rig states the
 * same thing in its own header — "a behavioral comparison over deliberately different data footprints, not a claim that
 * the arms have equivalent indexes". So the reading is fixed at {@link VariableIsolation.CrossEngine} and the caller's
 * `variable` is echoed rather than checked: there is nothing to check it against.
 */
export function crossEngineReading(armA: string, armB: string, declared: string[]): ConfoundReading {
	return {
		variable_isolation: VariableIsolation.CrossEngine,
		variable_effective: ["engine"],
		declared: [...declared].toSorted(),
		declared_but_unmoved: [],
		moved_but_undeclared: declared.includes("engine") ? [] : ["engine"],
		warnings: [
			`${armA} and ${armB} are different geocoders over different indexes. No delta here belongs to a lever: ` +
				"coverage, source vintage and ranking all move together, and nothing in either arm's provenance says by " +
				"how much. Read this as a behavioral comparison of two systems, never as an attribution.",
		],
	}
}

/**
 * The measured source difference between two worktree arms: what `git rev-list --count` and `git diff --name-only` say
 * separates the two commits. `range` is the exact ref pair the numbers came from, so the warning is re-runnable.
 */
export interface WorktreeTreeDelta {
	commits: number
	files: number
	range: string
}

/**
 * The reading for a comparison whose two arms are BOTH worktree arms with clean commits.
 *
 * {@link crossEngineReading}'s "different geocoders over different indexes" is written for Pelias-vs-mailwoman, where
 * nothing in either arm's provenance can bound the difference. A worktree pair is the opposite case: both arms name a
 * commit, so the tool can MEASURE what separates them and say it, instead of disclaiming an attribution the caller set
 * the comparison up to make. The isolation verdict stays {@link VariableIsolation.CrossEngine} — the config-key checker
 * still has nothing to check across two processes — but the warning carries the bounded surface: every difference lives
 * inside the named commits, and a reader can `git diff` the printed range.
 *
 * `delta: null` means a commit was dirty (`+dirty` suffix) or the git probe failed — the unbounded wording applies and
 * the runner's own not-reproducible caveat stands beside it.
 */
export function worktreePairReading(
	armA: string,
	armB: string,
	declared: string[],
	delta: WorktreeTreeDelta | null
): ConfoundReading {
	if (!delta) return crossEngineReading(armA, armB, declared)

	return {
		variable_isolation: VariableIsolation.CrossEngine,
		variable_effective: ["engine"],
		declared: [...declared].toSorted(),
		declared_but_unmoved: [],
		moved_but_undeclared: declared.includes("engine") ? [] : ["engine"],
		warnings: [
			`${armA} and ${armB} ran different source trees in separate processes. Measured delta: ${delta.commits} ` +
				`commit${delta.commits === 1 ? "" : "s"} touching ${delta.files} file${delta.files === 1 ? "" : "s"} ` +
				`(git diff ${delta.range}). Everything in those commits is inside this comparison — the attribution is ` +
				"exactly as narrow as that diff, no narrower.",
		],
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
const INCOMPARABLE_FIELDS = new Set(["resolver_score", "score", "prominence"])

export function assertComparableField(field: string): void {
	if (INCOMPARABLE_FIELDS.has(field)) {
		throw new Error(
			`Field ${JSON.stringify(field)} is not comparable. It is scored on different scales by different backends ` +
				`(bm25 ≈19–41 on FTS, population ≈5–7 on candidate), and within either backend the wrong answers' range ` +
				`sits inside the correct answers' range with a higher mean. There is no threshold on it that means anything.`
		)
	}
}

/**
 * Measure what separates two worktree arms' trees, from the commits their provenance names. Answers `null` — the
 * unbounded cross-engine wording — when either commit is dirty (`+dirty`: the tree is not reproducible from the sha, so
 * a diff against the sha under-counts it) or when git refuses the range (a sha from a since-pruned worktree).
 */
export function worktreeTreeDelta(
	repoRoot: string,
	provenanceA: Record<string, unknown>,
	provenanceB: Record<string, unknown>
): WorktreeTreeDelta | null {
	const commitA = typeof provenanceA["commit"] === "string" ? provenanceA["commit"] : null
	const commitB = typeof provenanceB["commit"] === "string" ? provenanceB["commit"] : null

	if (!commitA || !commitB || commitA.endsWith("+dirty") || commitB.endsWith("+dirty")) return null

	try {
		const commits = Number(
			execFileSync("git", ["rev-list", "--count", `${commitA}...${commitB}`], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim()
		)

		const diff = execFileSync("git", ["diff", "--name-only", commitA, commitB], {
			cwd: repoRoot,
			encoding: "utf8",
		}).trim()

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One `git diff --name-only` between two commits: bounded, and only the count is read.
		const files = diff ? diff.split("\n").length : 0

		return { commits, files, range: `${commitA.slice(0, 12)} ${commitB.slice(0, 12)}` }
	} catch {
		return null
	}
}
