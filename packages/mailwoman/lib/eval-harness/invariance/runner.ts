/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The invariance mini-suite runner (#886 five-whys follow-up). A standing, seconds-cheap
 *   metamorphic-invariance check meant to run in EVERY probe grade — not just the release Gauntlet's
 *   heavier resolver-level metamorphic layer (`gauntlet/cases/metamorphic.ts`, which asserts on assembled
 *   COORDINATES and is release-eval weight). This suite asserts on decoded PARSE COMPONENTS only (no
 *   resolver, no gazetteer DB), which is what keeps it cheap: a handful of pipeline calls per row, not
 *   geocode-and-resolve round trips.
 *
 *   Parses run through the PRODUCTION path — `createRuntimePipeline`, the same staged pipeline the API
 *   and CLI serve (normalize → query-shape → locale-hint → kind → grouper → classify), with the row's
 *   country-derived locale threaded per call and the weights package's FST auto-loaded when the
 *   classifier surfaces one (#1516). Routing matters: the old runner bypassed the pipeline with raw
 *   `classifier.parse`, which measured NEW violations on fr-montmartre and gb-quoted-venue that the
 *   shipped path never exhibits — and, worse, made the probe blind to the D-rule regressions that DO
 *   ride the pipeline stages a bypass skips.
 *
 *   For each (row, transform) pair: parse the original once per row (cached), parse the transformed string,
 *   and classify the pair via `compareComponents` — INVARIANT / DEGRADED / LOST. `idempotence` is special:
 *   it parses the SAME original string TWICE, independently (never reusing the cached parse), so it
 *   actually exercises the decode path twice rather than trivially comparing a cached result to itself.
 *
 *   `--baseline` mode (regression-focused, the shape a probe grade uses against v385): every candidate
 *   violation is also computed for the baseline model on the SAME pair. A violation the baseline ALSO
 *   exhibits is a PRE-EXISTING gap — reported, but it does not fail the check. Only a NEW violation (the
 *   baseline held INVARIANT, the candidate didn't) counts toward the LOST / `--max-degraded` thresholds.
 *   Two more regression-mode classes, both reported and non-blocking:
 *
 *   - GAINED: the candidate HOLDS a pair the baseline violated — a capability that went 0/207 → 205/207
 *     is a gain, not a violation (it gets its own report section, never the check).
 *   - gained-capability residual: a violation on a row whose baseline ORIGINAL parse carried no critical
 *     component (street/house_number/postcode) while the candidate's does — the baseline never had the
 *     row's core capability, so the pair is "gained but not register-flat", not a lost capability.
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
// resolves against the CWD the CLI is invoked from (the repo root), not `import.meta.dirname`.
//#region parse function construction

//#region the run

/**
 * `GAINED` is a regression-mode class, not a comparison class: the candidate held a pair the baseline violated — a
 * capability the baseline lacked, not a regression. It never counts toward the check.
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
	 * Only set in `--baseline` mode: the baseline model's verdict on the SAME pair.
	 */
	baselineVerdict?: Verdict
	/**
	 * True when the candidate violates but the baseline ALSO violates — reported, non-blocking.
	 */
	preExisting?: boolean
	/**
	 * Only set in `--baseline` mode, and only on rows the baseline never had the capability for: the baseline's ORIGINAL
	 * parse carried no CRITICAL_TAGS value while the candidate's does. Violations on such rows are "gained but not
	 * register-flat" residuals — reported, non-blocking, and never counted as pre-existing (the baseline did not "already
	 * violate"; it could not).
	 */
	gainedCapability?: boolean
}

export interface InvarianceReport {
	outcomes: PairOutcome[]
	skipped: Array<{ rowID: string; transformID: string; reason: string }>
	counts: { invariant: number; degraded: number; lost: number; gained: number }
	/**
	 * Counts restricted to NEW violations (baseline mode) — identical to `counts` when there's no baseline.
	 * Gained-capability residuals (and `GAINED` pairs) never land here.
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
	 * Fail the check if the NEW-violation DEGRADED count exceeds this. Default 0.
	 */
	maxDegraded?: number
	report?: (line: string) => void
}

/**
 * Canonicalize every value in a component map to long-form Ave/St/Rd (see `canonicalizeAbbreviations`).
 */
function canonicalizeMap(components: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [k, v] of Object.entries(components)) {
		out[k] = canonicalizeAbbreviations(v)
	}

	return out
}

/**
 * Compare two component maps for a given transform id. `abbreviation-swap` canonicalizes BOTH sides to long-form first
 * (see `canonicalizeAbbreviations`'s doc comment) so the transform's own intended text change isn't misread as a
 * violation; every other transform compares verbatim.
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
 * True when any CRITICAL_TAGS value is present (non-blank). The row-level gained-capability detector in
 * `runInvarianceSuite` keys on this: a baseline whose ORIGINAL parse carries no critical component never parsed the
 * row's core address — everything the candidate does afterwards is a gain, not a loss.
 */
function hasCriticalComponent(components: Record<string, string>): boolean {
	return CRITICAL_TAGS.some((tag) => (components[tag] ?? "").trim().length > 0)
}

/**
 * Run the full suite. Returns a report with per-pair outcomes, summary counts, and the check exit code.
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
		// Warm the original-parse cache once per row so every non-idempotence transform below reuses it
		// instead of re-parsing the same baseline string per transform.
		await originalFor(row)

		// #1516 gained-capability class (row-level): the baseline's ORIGINAL parse carries no
		// CRITICAL_TAGS value while the candidate's does — the baseline never had the row's core
		// capability (measured: v4.0.1 never emits street/dependent_locality for the quoted venue in
		// ANY register; v4.2.0 does in 7/8). Every violation on such a row is "gained but not
		// register-flat": reported non-blocking, and never counted as pre-existing — the baseline did
		// not "already violate", it could not.
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
				// A SECOND, independent call — the point of idempotence.
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
					// Gained-capability class (#1516): the candidate HOLDS a pair the baseline violated.
					// A capability that went 0/207 → 205/207 is a gain, not a violation — it is reported
					// in its own section below and never touches the check.
					outcome.verdict = "GAINED"
				} else {
					// Severity-aware, NOT severity-blind: a violation is pre-existing only if the candidate's verdict
					// is not WORSE than the baseline's on this SAME (row, transform) pair — INVARIANT < DEGRADED <
					// LOST. Treating two non-INVARIANT verdicts as pre-existing regardless of severity would let a
					// candidate LOST slide through as "non-blocking" whenever the baseline merely DEGRADED on the
					// same pair: baseline drops a non-critical `unit` on comma-drop, candidate drops the CRITICAL
					// `house_number` on the identical pair — that must check, not hide.
					// v1 is verdict-severity matching only, not content-diff matching: it doesn't check whether the
					// candidate's LOST is the SAME underlying break as the baseline's LOST (e.g. same tag, same kind
					// of corruption) — only that it's no worse in kind. A future tightening could require the diffs
					// to name the same tag before calling two LOSTs "the same" pre-existing gap.
					// Gained-capability rows never reach this severity comparison as pre-existing: the baseline
					// never had the row's critical components, so "the baseline also violates" is inapplicable.
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
			// Gained-capability residuals are excluded from newCounts exactly like pre-existing violations —
			// the baseline never had the row's capability, so the pair cannot be a lost one.
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

	// GAINED is a regression-mode class, not a violation — the candidate held a pair the baseline violated.
	const violations = outcomes.filter((o) => o.verdict !== "INVARIANT" && o.verdict !== "GAINED")

	if (violations.length) {
		report(`\nviolations:`)

		for (const v of violations) {
			const tag = v.verdict === "LOST" ? "✗ LOST" : "~ DEGRADED"

			// Print the baseline's ACTUAL recorded verdict rather than asserting one: "not pre-existing" (worse
			// severity than the baseline) does NOT imply the baseline held INVARIANT — it could itself have been
			// DEGRADED while the candidate is the strictly-worse LOST.
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

//#endregion
