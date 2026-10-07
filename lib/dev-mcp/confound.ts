/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isIdentical } from "@mailwoman/core/identical"
import { stringifyJSON } from "@mailwoman/core/json"
import { runFileSync } from "@mailwoman/core/process"

import { effectiveKeyFor } from "#dev-mcp/engine/registry"
import type { RoutedArtifactRecord } from "#dev-mcp/routed-mailwoman-arm"

/**
 * Enumerates how cleanly a two-arm comparison isolates its declared configuration
 * variables: `clean` means only declared keys moved.
 *
 * `ambiguous` means undeclared keys also moved.
 * `no_variable` means no key moved.
 *
 * `cross_engine` means the arms use different systems, so the delta cannot be attributed to a pin.
 */
export const VariableIsolation = {
	Clean: "clean",

	Ambiguous: "ambiguous",

	NoVariable: "no_variable",

	CrossEngine: "cross_engine",
} as const

/**
 * Names one {@link VariableIsolation} state.
 */
export type VariableIsolation = (typeof VariableIsolation)[keyof typeof VariableIsolation]

/**
 * Reports the effective configuration keys that differ between two comparison arms.
 *
 * It compares those keys with the declared keys and records warnings for delta attribution.
 */
export interface ConfoundReading {
	variable_isolation: VariableIsolation

	variable_effective: string[]
	declared: string[]
	declared_but_unmoved: string[]
	moved_but_undeclared: string[]
	warnings: string[]
}

function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])

	return [...keys].filter((key) => !isIdentical(a[key], b[key])).toSorted()
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

	const declaredSet = new Set(declared.map(effectiveKeyFor))
	const movedSet = new Set(moved)

	const movedButUndeclared = moved.filter((key) => !declaredSet.has(key))

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
				"exactly as narrow as that diff.",
		],
	}
}

const INCOMPARABLE_FIELDS = new Set(["resolver_score", "score", "prominence"])

/**
 * Throws when asked to compare a score field whose scale differs between resolver backends.
 *
 * Within either backend the wrong answers' scores also overlap the correct answers',
 * so no threshold on these fields is meaningful.
 */
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
 * One locale's resolved artifacts, keyed by artifact name.
 */
type ResolvedByName = Map<string, Pick<RoutedArtifactRecord, "origin" | "path" | "digest">>

/**
 * Reads one locale's artifact records, with a `null` digest where the arm recorded none.
 *
 * Two recorded digests that differ make isolation ambiguous.
 * A `null` on either side leaves the comparison unable to establish whether the bytes agree.
 * That is a different reading from agreement.
 */
function readArtifacts(value: unknown): RoutedArtifactRecord[] | null {
	if (!Array.isArray(value)) return null

	const artifacts: RoutedArtifactRecord[] = []

	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) return null

		const record = entry as Record<string, unknown>
		const name = record["name"]

		if (typeof name !== "string") return null

		artifacts.push({
			name,
			path: typeof record["path"] === "string" ? record["path"] : null,
			origin: typeof record["origin"] === "string" ? record["origin"] : null,
			digest: typeof record["digest"] === "string" ? record["digest"] : null,
		})
	}

	return artifacts
}

/**
 * Reads the artifact names one routed arm resolved for each locale, paired with the rung that supplied each.
 *
 * Returns `null` when an arm's provenance has no routed artifact record.
 * External geocoders, oracles.
 *
 * Runs recorded before the record existed have no such record.
 */
function resolvedArtifactsByLocale(provenance: unknown): Map<string, ResolvedByName> | null {
	if (typeof provenance !== "object" || provenance === null) return null

	const byLocale = (provenance as Record<string, unknown>)["artifacts_by_locale"]

	if (!Array.isArray(byLocale)) return null

	const locales = new Map<string, ResolvedByName>()

	for (const entry of byLocale) {
		if (typeof entry !== "object" || entry === null) return null

		const record = entry as Record<string, unknown>
		const locale = record["locale"]
		const artifacts = readArtifacts(record["artifacts"])

		if (typeof locale !== "string" || artifacts === null) return null

		const resolved: ResolvedByName = new Map()

		for (const artifact of artifacts) {
			if (artifact.path === null) continue

			resolved.set(artifact.name, {
				origin: artifact.origin ?? "unstated",
				path: artifact.path,
				digest: artifact.digest ?? null,
			})
		}

		locales.set(locale, resolved)
	}

	return locales
}

function pronounFor(artifacts: string[]): string {
	return artifacts.length === 1 ? "it" : "them"
}

/**
 * Warns when the two arms fed the model different weights artifacts.
 *
 * `resolveWeights` admits each artifact by existence.
 * A weights directory holding part of the concrete set its `files` array declares
 * therefore resolves the artifacts present and omits the rest without failing.
 *
 * Two arms can run the same model graph over different channels.
 * A row difference caused by those channels belongs to the artifact set rather than the declared pin.
 *
 * A workspace directory takes precedence over the data-root overlay.
 * This is how one arm acquires a channel its counterpart lacks.
 *
 * Returns an empty list when both arms resolved the same names for every locale or
 * when either arm's provenance reports no routed artifacts.
 */
export function artifactSetWarnings(provenanceA: unknown, provenanceB: unknown): string[] {
	const armA = resolvedArtifactsByLocale(provenanceA)
	const armB = resolvedArtifactsByLocale(provenanceB)

	if (!armA || !armB) return []

	const divergences: string[] = []

	for (const locale of [...new Set([...armA.keys(), ...armB.keys()])].toSorted()) {
		const a = armA.get(locale)
		const b = armB.get(locale)

		if (!a || !b) {
			divergences.push(`${locale} is routed by arm ${a ? "A" : "B"} alone.`)

			continue
		}

		const onlyA = [...a.keys()].filter((name) => !b.has(name)).toSorted()
		const onlyB = [...b.keys()].filter((name) => !a.has(name)).toSorted()

		if (onlyA.length) {
			divergences.push(`${locale}: arm A fed ${onlyA.join(", ")} and arm B left ${pronounFor(onlyA)} unresolved.`)
		}

		if (onlyB.length) {
			divergences.push(`${locale}: arm B fed ${onlyB.join(", ")} and arm A left ${pronounFor(onlyB)} unresolved.`)
		}

		// An artifact both arms resolved under one name can still hold different bytes.
		// The name comparison above reads that as agreement.
		for (const name of [...a.keys()].filter((key) => b.has(key)).toSorted()) {
			const left = a.get(name)!
			const right = b.get(name)!

			if (!left.digest || !right.digest) continue

			if (left.digest !== right.digest) {
				divergences.push(
					`${locale}: both arms fed ${name} and the bytes differ — arm A ${left.digest.slice(0, 12)} at ` +
						`${left.path}, arm B ${right.digest.slice(0, 12)} at ${right.path}.`
				)
			}
		}
	}

	if (!divergences.length) return []

	return [
		`The arms resolved different weights artifacts, so a row difference here can belong to the channels ` +
			`rather than to the declared pin. ${divergences.join(" ")} Stage both arms from the same package ` +
			`declaration with \`mwops release stage-weights-cache\` and pin \`weights_cache\` on both sides, ` +
			`which makes the model graph the only difference between them.`,
	]
}

/**
 * Counts the commits and changed files between two worktree arms' recorded commits.
 *
 * Returns `null` when either arm lacks a commit, either was dirty, or git fails.
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
