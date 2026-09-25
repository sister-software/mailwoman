/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs component-level invariance checks through the production runtime pipeline without resolver I/O. With a
 *   baseline parser, only violations the baseline lacks count toward failure.
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

/**
 * Verdict for one pair.
 *
 * `GAINED` means the candidate holds a pair that the baseline violated, and it never fails the check.
 */
export type OutcomeVerdict = Verdict | "GAINED"

/**
 * Result for one row and transform.
 */
export interface PairOutcome {
	rowID: string
	raw: string
	country: string
	transformID: string
	transformed: string
	verdict: OutcomeVerdict
	diff: string[]
	/**
	 * Baseline parser's verdict on the same pair.
	 * It is set only in baseline mode.
	 */
	baselineVerdict?: Verdict
	/**
	 * Whether the candidate's violation is no more severe than the baseline's verdict on the same pair.
	 */
	preExisting?: boolean
	/**
	 * Whether the row's original parse has a critical component from the candidate
	 * and none from the baseline.
	 */
	gainedCapability?: boolean
}

/**
 * Pair outcomes, counts, and the check verdict for a suite run.
 */
export interface InvarianceReport {
	outcomes: PairOutcome[]
	skipped: Array<{ rowID: string; transformID: string; reason: string }>
	counts: { invariant: number; degraded: number; lost: number; gained: number }
	/**
	 * Counts of violations that the baseline lacks.
	 * Without a baseline, every violation counts as new.
	 */
	newCounts: { degraded: number; lost: number; gained: number }
	pass: boolean
	exitCode: number
}

/**
 * Options for {@link runInvarianceSuite}.
 */
export interface RunInvarianceOptions {
	rows: InvarianceRow[]
	parse: ParseFn
	/**
	 * Baseline parser.
	 *
	 * When set, violations that the baseline shares are reported without failing the check.
	 */
	baselineParse?: ParseFn
	/**
	 * Largest number of new `DEGRADED` pairs that still passes.
	 * It defaults to 0.
	 */
	maxDegraded?: number
	report?: (line: string) => void
}

/**
 * Expands supported abbreviations in every component value.
 */
function canonicalizeMap(components: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [k, v] of Object.entries(components)) {
		out[k] = canonicalizeAbbreviations(v)
	}

	return out
}

/**
 * Compares component maps.
 *
 * For `abbreviation-swap`, both maps are canonicalized first so the expected
 * spelling change does not count as a difference.
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
 * Reports whether any critical component has a non-blank value.
 */
function hasCriticalComponent(components: Record<string, string>): boolean {
	return CRITICAL_TAGS.some((tag) => (components[tag] ?? "").trim().length)
}

/**
 * Runs the suite, prints a summary through `options.report`, and returns the report.
 */
export async function runInvarianceSuite(options: RunInvarianceOptions): Promise<InvarianceReport> {
	const maxDegraded = options.maxDegraded ?? 0
	const report = options.report ?? console.error
	const outcomes: PairOutcome[] = []
	const skipped: Array<{ rowID: string; transformID: string; reason: string }> = []

	// The idempotence check compares a cached parse with a fresh one, so its second call bypasses this cache.
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
		await originalFor(row)

		const gainedCapabilityRow =
			options.baselineParse !== undefined &&
			!hasCriticalComponent(await baselineOriginalFor(row)) &&
			hasCriticalComponent(await originalFor(row))

		const rowLocale = localeForCountry(row.country)

		for (const transformID of row.transforms) {
			// `getTransform` throws on an unknown ID, which catches fixture typos.
			const transform = getTransform(transformID)
			const transformedText: string | null = transformID === "idempotence" ? row.raw : transform.apply(row.raw)

			if (transformedText == null) {
				skipped.push({ rowID: row.id, transformID, reason: "transform not applicable to this raw" })

				continue
			}

			let candidateOutcome: ReturnType<typeof compareComponents> & { transformed: string }

			if (transformID === "idempotence") {
				const a = await originalFor(row)
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
					outcome.verdict = "GAINED"
				} else {
					// The comparison uses verdict severity only.
					// The diff contents may differ.
					outcome.preExisting =
						!gainedCapabilityRow &&
						candidateOutcome.verdict !== "INVARIANT" &&
						VERDICT_SEVERITY[candidateOutcome.verdict] <= VERDICT_SEVERITY[baselineResult.verdict]
				}
			}

			outcomes.push(outcome)
		}
	}

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
			// Violations on gained-capability rows do not count as new, because the baseline never parsed those rows.
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

	const violations = outcomes.filter((o) => o.verdict !== "INVARIANT" && o.verdict !== "GAINED")

	if (violations.length) {
		report(`\nviolations:`)

		for (const v of violations) {
			const tag = v.verdict === "LOST" ? "✗ LOST" : "~ DEGRADED"

			// A new violation can have a violating baseline of lower severity, so the report prints the baseline verdict.
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
