/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run component-level invariance checks through the production runtime pipeline.
 *   The suite avoids resolver I/O and compares original/transformed parses.
 *   Baseline mode reports pre-existing violations and gains separately; only new regressions
 *   count toward the failure thresholds.
 */

import { compareComponents, CRITICAL_TAGS, VERDICT_SEVERITY, type Verdict } from "#eval-harness/invariance/compare"
import type { InvarianceRow } from "#eval-harness/invariance/fixtures"
import { localeForCountry, type ParseFn } from "#eval-harness/invariance/parser"
import { canonicalizeAbbreviations, getTransform } from "#eval-harness/invariance/transforms"

export {
	buildParseFn,
	COUNTRY_TO_LOCALE,
	localeForCountry,
	type ModelSelectOptions,
	type ParseCallOpts,
	type ParseFn,
} from "#eval-harness/invariance/parser"

export { DEFAULT_SUITE_PATH, loadSuite, type InvarianceRow } from "#eval-harness/invariance/fixtures"

// Repo-root-relative (mirrors `FRAGMENT_BOARD_FIXTURES` / `POI_BOARD_FIXTURES`): the compiled tree
// (`out/`) never gets a copy of the `.jsonl` fixture — only `.ts` sources are transpiled — so this
// resolves against the CWD the CLI is invoked from (the repo root) rather than `import.meta.dirname`.
// #region parse function construction

// #region the run

/**
 * `GAINED` means the candidate holds a pair the baseline violated; it is non-blocking.
 */
export type OutcomeVerdict = Verdict | "GAINED"

export interface PairOutcome {
	rowID: string
	raw: string
	country: string
	transformID: string
	transformed: string
	verdict: OutcomeVerdict
	diff: string[]
	/**
	 * Only set in `--baseline` mode: the baseline model's verdict on the same pair.
	 */
	baselineVerdict?: Verdict
	/**
	 * True when the candidate violation is no worse than the baseline's.
	 */
	preExisting?: boolean
	/**
	 * Set when the baseline had no critical component but the candidate did.
	 */
	gainedCapability?: boolean
}

export interface InvarianceReport {
	outcomes: PairOutcome[]
	skipped: Array<{ rowID: string; transformID: string; reason: string }>
	counts: { invariant: number; degraded: number; lost: number; gained: number }
	/**
	 * New-violation counts; equals `counts` when no baseline is supplied.
	 */
	newCounts: { degraded: number; lost: number; gained: number }
	pass: boolean
	exitCode: number
}

export interface RunInvarianceOptions {
	rows: InvarianceRow[]
	parse: ParseFn
	/**
	 * `--baseline` regression mode: pre-existing baseline violations are reported but non-blocking.
	 */
	baselineParse?: ParseFn
	/**
	 * Fail the check if the new-violation degraded count exceeds this.
	 *
	 * Default 0.
	 */
	maxDegraded?: number
	report?: (line: string) => void
}

/**
 * Expand supported abbreviations in every component value.
 */
function canonicalizeMap(components: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [k, v] of Object.entries(components)) {
		out[k] = canonicalizeAbbreviations(v)
	}

	return out
}

/**
 * Compare component maps, normalizing expected spelling changes for abbreviation swaps.
 */
function compareForTransform(
	transformID: string,
	original: Record<string, string>,
	transformed: Record<string, string>
): ReturnType<typeof compareComponents> {
	if (transformID === "abbreviation-swap") {
		return compareComponents(canonicalizeMap(original), canonicalizeMap(transformed))
	}

	return compareComponents(original, transformed)
}

/**
 * Check whether any critical component has a nonblank value.
 */
function hasCriticalComponent(components: Record<string, string>): boolean {
	return CRITICAL_TAGS.some((tag) => (components[tag] ?? "").trim().length)
}

/**
 * Run the suite and return per-pair results and summary counts.
 *
 * @returns A report with per-pair outcomes, summary counts, and the check exit code.
 */
export async function runInvarianceSuite(options: RunInvarianceOptions): Promise<InvarianceReport> {
	const maxDegraded = options.maxDegraded ?? 0
	const report = options.report ?? console.error
	const outcomes: PairOutcome[] = []
	const skipped: Array<{ rowID: string; transformID: string; reason: string }> = []

	// Cache each row's original parse once (idempotence deliberately bypasses this cache — see runPair).
	const originalCache = new Map<string, Record<string, string>>()

	async function originalFor(row: InvarianceRow): Promise<Record<string, string>> {
		let cached = originalCache.get(row.id)

		if (!cached) {
			cached = await options.parse(row.raw, { locale: localeForCountry(row.country) })
			originalCache.set(row.id, cached)
		}

		return cached
	}

	const baselineOriginalCache = new Map<string, Record<string, string>>()

	async function baselineOriginalFor(row: InvarianceRow): Promise<Record<string, string>> {
		let cached = baselineOriginalCache.get(row.id)

		if (!cached) {
			cached = await options.baselineParse!(row.raw, { locale: localeForCountry(row.country) })
			baselineOriginalCache.set(row.id, cached)
		}

		return cached
	}

	for (const row of options.rows) {
		// Warm the original-parse cache once per row so every non-idempotence transform below
		// reuses it instead of re-parsing the same baseline string per transform.
		await originalFor(row)

		// Track rows where the baseline lacks critical components but the candidate has them.
		const gainedCapabilityRow =
			options.baselineParse !== undefined &&
			!hasCriticalComponent(await baselineOriginalFor(row)) &&
			hasCriticalComponent(await originalFor(row))

		// Production caller hint for every parse of this row (locale-hint / normalize case-fold).
		const rowLocale = localeForCountry(row.country)

		for (const transformID of row.transforms) {
			const transform = getTransform(transformID) // throws loudly on an unknown id — fixture typo guard.
			const transformedText: string | null = transformID === "idempotence" ? row.raw : transform.apply(row.raw)

			if (transformedText == null) {
				skipped.push({ rowID: row.id, transformID, reason: "transform not applicable to this raw" })

				continue
			}

			let candidateOutcome: ReturnType<typeof compareComponents> & { transformed: string }

			if (transformID === "idempotence") {
				const a = await originalFor(row)
				// A second, independent call — the point of idempotence.
				const b = await options.parse(row.raw, { locale: rowLocale })
				candidateOutcome = { transformed: row.raw, ...compareForTransform(transformID, a, b) }
			} else {
				const original = await originalFor(row)
				const perturbed = await options.parse(transformedText, { locale: rowLocale })

				candidateOutcome = {
					transformed: transformedText,
					...compareForTransform(transformID, original, perturbed),
				}
			}

			const outcome: PairOutcome = {
				rowID: row.id,
				raw: row.raw,
				country: row.country,
				transformID,
				transformed: candidateOutcome.transformed,
				verdict: candidateOutcome.verdict,
				diff: candidateOutcome.diff,
			}

			if (options.baselineParse) {
				const baselineResult =
					transformID === "idempotence"
						? await (async () => {
								const a = await baselineOriginalFor(row)
								const b = await options.baselineParse!(row.raw, { locale: rowLocale })

								return compareForTransform(transformID, a, b)
							})()
						: await (async () => {
								const original = await baselineOriginalFor(row)
								const perturbed = await options.baselineParse!(transformedText!, { locale: rowLocale })

								return compareForTransform(transformID, original, perturbed)
							})()

				outcome.baselineVerdict = baselineResult.verdict
				outcome.gainedCapability = gainedCapabilityRow

				if (candidateOutcome.verdict === "INVARIANT" && baselineResult.verdict !== "INVARIANT") {
					// Gained-capability class (#1516): the candidate holds a pair the baseline violated.
					// A capability that went 0/207 → 205/207 is a gain rather than a violation.
					// It is reported in its own section below and never touches the check.
					outcome.verdict = "GAINED"
				} else {
					// Treat a violation as pre-existing only when its severity is no worse
					// than the baseline's for the same pair.
					// This compares verdict levels, not the underlying diff contents.
					outcome.preExisting =
						!gainedCapabilityRow &&
						candidateOutcome.verdict !== "INVARIANT" &&
						VERDICT_SEVERITY[candidateOutcome.verdict] <= VERDICT_SEVERITY[baselineResult.verdict]
				}
			}

			outcomes.push(outcome)
		}
	}

	// Summarize and report the invariance outcomes.
	const counts = { invariant: 0, degraded: 0, lost: 0, gained: 0 }
	const newCounts = { degraded: 0, lost: 0, gained: 0 }

	for (const o of outcomes) {
		if (o.verdict === "INVARIANT") {
			counts.invariant++
		} else if (o.verdict === "DEGRADED") {
			counts.degraded++
		} else if (o.verdict === "LOST") {
			counts.lost++
		} else {
			counts.gained++
		}

		if (o.verdict === "GAINED") {
			newCounts.gained++
		} else {
			// Exclude residuals on rows where the baseline lacked critical components.
			const isNew = !options.baselineParse || (!o.preExisting && !o.gainedCapability)

			if (isNew) {
				if (o.verdict === "DEGRADED") {
					newCounts.degraded++
				} else if (o.verdict === "LOST") {
					newCounts.lost++
				}
			}
		}
	}

	report(`\n=== invariance mini-suite ===`)
	report(`  rows: ${options.rows.length}   pairs: ${outcomes.length}   skipped (n/a): ${skipped.length}`)

	report(
		`  INVARIANT ${counts.invariant}   DEGRADED ${counts.degraded}${options.baselineParse ? ` (${newCounts.degraded} new)` : ""}   LOST ${counts.lost}${options.baselineParse ? ` (${newCounts.lost} new)` : ""}${options.baselineParse ? `   GAINED ${counts.gained}` : ""}`
	)

	// Gains are reported separately and never treated as violations.
	const violations = outcomes.filter((o) => o.verdict !== "INVARIANT" && o.verdict !== "GAINED")

	if (violations.length) {
		report(`\nviolations:`)

		for (const v of violations) {
			const tag = v.verdict === "LOST" ? "✗ LOST" : "~ DEGRADED"

			// Show the baseline verdict; a new violation need not have an invariant baseline.
			const provenance = options.baselineParse
				? v.preExisting
					? " [pre-existing: baseline also violates — non-blocking]"
					: v.gainedCapability
						? " [gained-capability residual — the baseline never parsed this row's critical components — non-blocking]"
						: ` [NEW — baseline verdict was ${v.baselineVerdict}]`
				: ""

			report(`  ${tag} [${v.transformID}] ${v.rowID} "${v.raw}" → "${v.transformed}"${provenance}`)

			for (const d of v.diff) {
				report(`      ${d}`)
			}
		}
	}

	if (options.baselineParse) {
		const gains = outcomes.filter((o) => o.verdict === "GAINED")

		if (gains.length) {
			report(`\ngains (capability the baseline lacked, the candidate holds — non-blocking):`)

			for (const g of gains) {
				report(
					`  + GAINED [${g.transformID}] ${g.rowID} "${g.raw}" → "${g.transformed}" [baseline verdict was ${g.baselineVerdict}]`
				)
			}
		}
	}

	if (skipped.length) {
		report(`\nskipped (transform declared but not applicable — check the fixture):`)

		for (const s of skipped) {
			report(`  ${s.rowID} / ${s.transformID}: ${s.reason}`)
		}
	}

	const pass = newCounts.lost === 0 && newCounts.degraded <= maxDegraded

	report(
		`\nverdict: ${pass ? "PASS" : "FAIL"} (max-degraded ${maxDegraded}${options.baselineParse ? ", regression mode vs baseline" : ""})`
	)

	return {
		outcomes,
		skipped,
		counts,
		newCounts,
		pass,
		exitCode: pass ? 0 : 1,
	}
}

// #endregion
