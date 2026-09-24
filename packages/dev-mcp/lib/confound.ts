/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare effective configuration changes with declared variables. Warn about undeclared or unchanged pins without
 *   blocking the comparison.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { runFileSync } from "@mailwoman/core/process"

import { effectiveKeyFor } from "#engine/registry"

/**
 * Configuration-isolation states.
 *
 * This module does not diagnose individual row changes; use `mwdev_trace` for that.
 */
export const VariableIsolation = {
	/**
	 * Only declared keys differ.
	 */
	Clean: "clean",
	/**
	 * At least one undeclared key differs.
	 */
	Ambiguous: "ambiguous",
	/**
	 * Effective configurations match; output differences have another cause.
	 */
	NoVariable: "no_variable",
	/**
	 * Arms use different geocoders.
	 */
	CrossEngine: "cross_engine",
} as const

export type VariableIsolation = (typeof VariableIsolation)[keyof typeof VariableIsolation]

export interface ConfoundReading {
	variable_isolation: VariableIsolation
	/**
	 * Keys that differ, whether or not they were declared.
	 */
	variable_effective: string[]
	declared: string[]
	/**
	 * Declared keys that are identical across both arms.
	 */
	declared_but_unmoved: string[]
	/**
	 * Undeclared keys that changed.
	 */
	moved_but_undeclared: string[]
	warnings: string[]
}

function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])

	return [...keys].filter((key) => stringifyJSON(a[key]) !== stringifyJSON(b[key])).toSorted()
}

/**
 * Compare effective configuration changes with declared keys.
 */
export function checkConfounds(
	effectiveA: Record<string, unknown>,
	effectiveB: Record<string, unknown>,
	declared: string[]
): ConfoundReading {
	const moved = differingKeys(effectiveA, effectiveB)
	// Translate CLI keys to effective config keys.
	const declaredSet = new Set(declared.map(effectiveKeyFor))
	const movedSet = new Set(moved)

	const movedButUndeclared = moved.filter((key) => !declaredSet.has(key))
	// Keep the caller's spelling in warnings.
	const declaredButUnmoved = declared.filter((key) => !movedSet.has(effectiveKeyFor(key))).toSorted()
	const warnings: string[] = []

	if (movedButUndeclared.length) {
		warnings.push(
			`Undeclared differences: ${movedButUndeclared.join(", ")}. The delta cannot be attributed to ` +
				`${declared.length ? declared.join(", ") : "any single pin"} alone — these moved too. ` +
				`Either pin them across both arms, or declare them and read the result as one row of a 2×2.`
		)
	}

	if (declaredButUnmoved.length) {
		warnings.push(
			`Declared but identical in both arms: ${declaredButUnmoved.join(", ")}. ` +
				`Either the declaration is wrong or both arms resolved that pin to the same default.`
		)
	}

	if (!moved.length) {
		warnings.push(
			"The two arms have identical effective configurations. Any difference between them comes from outside this " +
				"record — nondeterminism or external state — not from a pin."
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
 * Describe an engine comparison without attributing it to configuration pins.
 */
export function crossEngineReading(armA: string, armB: string, declared: string[]): ConfoundReading {
	return {
		variable_isolation: VariableIsolation.CrossEngine,
		variable_effective: ["engine"],
		declared: [...declared].toSorted(),
		declared_but_unmoved: [],
		moved_but_undeclared: declared.includes("engine") ? [] : ["engine"],
		warnings: [
			`${armA} and ${armB} are different geocoders over different indexes. No delta here belongs to a pin: ` +
				"coverage, source vintage and ranking all move together, and nothing in either arm's provenance says by " +
				"how much. Read this as a behavioral comparison of two systems, never as an attribution.",
		],
	}
}

/**
 * Commit and file differences between worktree arms, including the exact refs measured.
 */
export interface WorktreeTreeDelta {
	commits: number
	files: number
	range: string
}

/**
 * Describe source differences using each worktree arm's recorded commit.
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
 * Score fields whose scales differ across backends.
 */
const INCOMPARABLE_FIELDS = new Set(["resolver_score", "score", "prominence"])

export function assertComparableField(field: string): void {
	if (INCOMPARABLE_FIELDS.has(field)) {
		throw new Error(
			`Field ${stringifyJSON(field)} is not comparable. It is scored on different scales by different backends ` +
				`(bm25 ≈19–41 on FTS, population ≈5–7 on candidate), and within either backend the wrong answers' range ` +
				`sits inside the correct answers' range with a higher mean. There is no threshold on it that means anything.`
		)
	}
}

/**
 * Measure commit and file differences, or return `null` when either worktree
 * is dirty or the git query fails.
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
			runFileSync("git", ["rev-list", "--count", `${commitA}...${commitB}`], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim()
		)

		const diff = runFileSync("git", ["diff", "--name-only", commitA, commitB], {
			cwd: repoRoot,
			encoding: "utf8",
		}).trim()

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- This bounded diff is used only to count changed files.
		const files = diff ? diff.split("\n").length : 0

		return { commits, files, range: `${commitA.slice(0, 12)} ${commitB.slice(0, 12)}` }
	} catch {
		return null
	}
}
