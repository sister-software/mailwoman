/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The invariance mini-suite runner (#886 five-whys follow-up). A standing, seconds-cheap
 *   metamorphic-invariance check meant to run in EVERY probe grade — not just the release Gauntlet's
 *   heavier resolver-level metamorphic layer (`gauntlet/cases/metamorphic.ts`, which asserts on assembled
 *   COORDINATES and is release-gate weight). This suite asserts on decoded PARSE COMPONENTS only (no
 *   resolver, no gazetteer DB), which is what makes it 2k-probe cheap: it's a handful of `classifier.parse`
 *   calls, not a geocode-and-resolve round trip.
 *
 *   For each (row, transform) pair: parse the original once per row (cached), parse the transformed string,
 *   and classify the pair via `compareComponents` — INVARIANT / DEGRADED / LOST. `idempotence` is special:
 *   it parses the SAME original string TWICE, independently (never reusing the cached parse), so it
 *   actually exercises the decode path twice rather than trivially comparing a cached result to itself.
 *
 *   `--baseline` mode (regression-focused, the shape a probe grade uses against v385): every candidate
 *   violation is also computed for the baseline model on the SAME pair. A violation the baseline ALSO
 *   exhibits is a PRE-EXISTING gap — reported, but it does not fail the gate. Only a NEW violation (the
 *   baseline held INVARIANT, the candidate didn't) counts toward the LOST / `--max-degraded` thresholds.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer } from "@mailwoman/neural/scorer"

import { compareComponents, type Verdict } from "./compare.ts"
import { canonicalizeAbbreviations, getTransform } from "./transforms.ts"

// Repo-root-relative (mirrors `FRAGMENT_BOARD_FIXTURES` / `POI_BOARD_FIXTURES`): the compiled tree
// (`out/`) never gets a copy of the `.jsonl` fixture — only `.ts` sources are transpiled — so this
// resolves against the CWD the CLI is invoked from (the repo root), not `import.meta.dirname`.
export const DEFAULT_SUITE_PATH = "mailwoman/eval-harness/invariance/suite.jsonl"

// -------------------------------------------------------------------------------------------------
// fixture loading
// -------------------------------------------------------------------------------------------------

export interface InvarianceRow {
	id: string
	raw: string
	country: string
	/** Transform ids (see transforms.ts) that apply to this row. */
	transforms: string[]
}

/** Load `suite.jsonl`-shaped rows. Blank lines and `//`-prefixed comment lines (the fixture header) are skipped. */
export function loadSuite(path: string = DEFAULT_SUITE_PATH): InvarianceRow[] {
	if (!existsSync(path)) throw new Error(`invariance suite not found: ${path}`)

	const rows: InvarianceRow[] = []

	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim()

		if (!trimmed || trimmed.startsWith("//")) continue
		rows.push(JSON.parse(trimmed) as InvarianceRow)
	}

	return rows
}

// -------------------------------------------------------------------------------------------------
// parse function construction
// -------------------------------------------------------------------------------------------------

export type ParseFn = (raw: string) => Promise<Record<string, string>>

/** Options that select a model — mirrors the shape of `eval gate` / `eval error-analysis`. */
export interface ModelSelectOptions {
	/** Candidate ONNX (requires `tokenizer` + `modelCard`, or falls back to co-located siblings via `weightsCache`). */
	model?: string
	tokenizer?: string
	modelCard?: string
	/**
	 * Package-shaped weights dir (`<root>/node_modules/@mailwoman/neural-weights-<locale>`) — #718-safe, resolves model +
	 * tokenizer + card + anchor/gazetteer siblings via `loadFromWeights`. Preferred over `model` for grading a candidate
	 * whose vocab differs (splice), and the only correct grade for a country-channel model. Alternative to `model`.
	 */
	weightsCache?: string
	/** BCP-47-ish locale tag for weights-package resolution. Default `en-US`. */
	locale?: string
}

async function buildClassifier(opts: ModelSelectOptions): Promise<NeuralAddressClassifier> {
	const locale = opts.locale ?? "en-US"

	if (opts.weightsCache) {
		return NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot: opts.weightsCache })
	}

	if (opts.model) {
		if (!opts.tokenizer || !opts.modelCard) {
			throw new Error("--model requires --tokenizer and --model-card (or pass --weights-cache instead)")
		}

		return createScorer({
			modelPath: resolve(opts.model),
			tokenizerPath: resolve(opts.tokenizer),
			modelCardPath: resolve(opts.modelCard),
			locale: locale.toLowerCase(),
		})
	}

	return NeuralAddressClassifier.loadFromWeights({ locale })
}

/** Build a `ParseFn` from model-select options. Exported so `--baseline` can build a second, independent classifier. */
export async function buildParseFn(opts: ModelSelectOptions): Promise<ParseFn> {
	const classifier = await buildClassifier(opts)

	return async (raw: string) => decodeAsJSON(await classifier.parse(raw)) as Record<string, string>
}

// -------------------------------------------------------------------------------------------------
// the run
// -------------------------------------------------------------------------------------------------

export interface PairOutcome {
	rowId: string
	raw: string
	country: string
	transformId: string
	transformed: string
	verdict: Verdict
	diff: string[]
	/** Only set in `--baseline` mode: the baseline model's verdict on the SAME pair. */
	baselineVerdict?: Verdict
	/** True when the candidate violates but the baseline ALSO violates — reported, non-blocking. */
	preExisting?: boolean
}

export interface InvarianceReport {
	outcomes: PairOutcome[]
	skipped: Array<{ rowId: string; transformId: string; reason: string }>
	counts: { invariant: number; degraded: number; lost: number }
	/** Counts restricted to NEW violations (baseline mode) — identical to `counts` when there's no baseline. */
	newCounts: { degraded: number; lost: number }
	pass: boolean
	exitCode: number
}

export interface RunInvarianceOptions {
	rows: InvarianceRow[]
	parse: ParseFn
	/** `--baseline` regression mode: pre-existing baseline violations are reported but non-blocking. */
	baselineParse?: ParseFn
	/** Fail the gate if the NEW-violation DEGRADED count exceeds this. Default 0. */
	maxDegraded?: number
	report?: (line: string) => void
}

/** Canonicalize every value in a component map to long-form Ave/St/Rd (see `canonicalizeAbbreviations`). */
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
	transformId: string,
	original: Record<string, string>,
	transformed: Record<string, string>
): ReturnType<typeof compareComponents> {
	if (transformId === "abbreviation-swap") {
		return compareComponents(canonicalizeMap(original), canonicalizeMap(transformed))
	}

	return compareComponents(original, transformed)
}

/** Run the full suite. Returns a report with per-pair outcomes, summary counts, and the gate exit code. */
export async function runInvarianceSuite(options: RunInvarianceOptions): Promise<InvarianceReport> {
	const maxDegraded = options.maxDegraded ?? 0
	const report = options.report ?? console.error
	const outcomes: PairOutcome[] = []
	const skipped: Array<{ rowId: string; transformId: string; reason: string }> = []

	// Cache each row's original parse once (idempotence deliberately bypasses this cache — see runPair).
	const originalCache = new Map<string, Record<string, string>>()

	async function originalFor(row: InvarianceRow): Promise<Record<string, string>> {
		let cached = originalCache.get(row.id)

		if (!cached) {
			cached = await options.parse(row.raw)
			originalCache.set(row.id, cached)
		}

		return cached
	}

	const baselineOriginalCache = new Map<string, Record<string, string>>()

	async function baselineOriginalFor(row: InvarianceRow): Promise<Record<string, string>> {
		let cached = baselineOriginalCache.get(row.id)

		if (!cached) {
			cached = await options.baselineParse!(row.raw)
			baselineOriginalCache.set(row.id, cached)
		}

		return cached
	}

	for (const row of options.rows) {
		// Warm the original-parse cache once per row so every non-idempotence transform below reuses it
		// instead of re-parsing the same baseline string per transform.
		await originalFor(row)

		for (const transformId of row.transforms) {
			const transform = getTransform(transformId) // throws loudly on an unknown id — fixture typo guard.
			let transformedText: string | null

			if (transformId === "idempotence") {
				transformedText = row.raw
			} else {
				transformedText = transform.apply(row.raw)
			}

			if (transformedText == null) {
				skipped.push({ rowId: row.id, transformId, reason: "transform not applicable to this raw" })
				continue
			}

			let candidateOutcome: ReturnType<typeof compareComponents> & { transformed: string }

			if (transformId === "idempotence") {
				const a = await originalFor(row)
				const b = await options.parse(row.raw) // a SECOND, independent call — the point of idempotence.
				candidateOutcome = { transformed: row.raw, ...compareForTransform(transformId, a, b) }
			} else {
				const original = await originalFor(row)
				const perturbed = await options.parse(transformedText)
				candidateOutcome = {
					transformed: transformedText,
					...compareForTransform(transformId, original, perturbed),
				}
			}

			const outcome: PairOutcome = {
				rowId: row.id,
				raw: row.raw,
				country: row.country,
				transformId,
				transformed: candidateOutcome.transformed,
				verdict: candidateOutcome.verdict,
				diff: candidateOutcome.diff,
			}

			if (options.baselineParse) {
				const baselineResult =
					transformId === "idempotence"
						? await (async () => {
								const a = await baselineOriginalFor(row)
								const b = await options.baselineParse!(row.raw)

								return compareForTransform(transformId, a, b)
							})()
						: await (async () => {
								const original = await baselineOriginalFor(row)
								const perturbed = await options.baselineParse!(transformedText!)

								return compareForTransform(transformId, original, perturbed)
							})()

				outcome.baselineVerdict = baselineResult.verdict
				outcome.preExisting = outcome.verdict !== "INVARIANT" && baselineResult.verdict !== "INVARIANT"
			}

			outcomes.push(outcome)
		}
	}

	// --- summary + report -------------------------------------------------------------------------
	const counts = { invariant: 0, degraded: 0, lost: 0 }
	const newCounts = { degraded: 0, lost: 0 }

	for (const o of outcomes) {
		if (o.verdict === "INVARIANT") {
			counts.invariant++
		} else if (o.verdict === "DEGRADED") {
			counts.degraded++
		} else {
			counts.lost++
		}

		const isNew = !options.baselineParse || !o.preExisting

		if (isNew) {
			if (o.verdict === "DEGRADED") {
				newCounts.degraded++
			} else if (o.verdict === "LOST") {
				newCounts.lost++
			}
		}
	}

	report(`\n=== invariance mini-suite ===`)
	report(`  rows: ${options.rows.length}   pairs: ${outcomes.length}   skipped (n/a): ${skipped.length}`)
	report(
		`  INVARIANT ${counts.invariant}   DEGRADED ${counts.degraded}${options.baselineParse ? ` (${newCounts.degraded} new)` : ""}   LOST ${counts.lost}${options.baselineParse ? ` (${newCounts.lost} new)` : ""}`
	)

	const violations = outcomes.filter((o) => o.verdict !== "INVARIANT")

	if (violations.length > 0) {
		report(`\nviolations:`)

		for (const v of violations) {
			const tag = v.verdict === "LOST" ? "✗ LOST" : "~ DEGRADED"
			const provenance = options.baselineParse
				? v.preExisting
					? " [pre-existing: baseline also violates — non-blocking]"
					: " [NEW — baseline held INVARIANT]"
				: ""
			report(`  ${tag} [${v.transformId}] ${v.rowId} "${v.raw}" → "${v.transformed}"${provenance}`)

			for (const d of v.diff) {
				report(`      ${d}`)
			}
		}
	}

	if (skipped.length > 0) {
		report(`\nskipped (transform declared but not applicable — check the fixture):`)

		for (const s of skipped) {
			report(`  ${s.rowId} / ${s.transformId}: ${s.reason}`)
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
