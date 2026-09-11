/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Shared exact-match per-tag scoring for weight-dependent evaluation checks.
 */

import type { SystemCode } from "@mailwoman/codex"
import { dataRootPath } from "@mailwoman/core/data-root"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { createScorer, type ScorerOverrides } from "@mailwoman/neural/scorer"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { JSONSpliterator } from "spliterator"

export interface PerTagEvalRow {
	raw: string
	components: Record<string, string>
}

/**
 * Address component vocabulary used by the unfolded affix evaluation checks.
 */
export const UNFOLDED_ADDRESS_TAGS = [
	"street_prefix",
	"street",
	"street_suffix",
	"house_number",
	"locality",
	"region",
	"postcode",
	"country",
	"unit",
	"intersection_a",
	"intersection_b",
	"po_box",
	"cedex",
	"venue",
	"dependent_locality",
	"subregion",
] as const

export async function loadPerTagEvalRows(files: readonly string[]): Promise<PerTagEvalRow[]> {
	const rows: PerTagEvalRow[] = []

	for (const file of files) {
		if (!(await pathExists(file))) throw new Error(`eval file not found: ${file}`)

		for await (const row of JSONSpliterator.fromAsync<PerTagEvalRow>(file)) {
			rows.push(row)
		}
	}

	return rows
}

/**
 * The one component normalization every exact-match scorer compares under.
 */
export const normalizeComponent = (value?: string): string => (value ?? "").trim().toLowerCase()

export function rowsHaveTag(rows: readonly PerTagEvalRow[], tag: string): boolean {
	return rows.some((row) => Boolean(normalizeComponent(row.components[tag])))
}

/**
 * One tag's exact-match counts.
 */
export interface PerTagCounts {
	tp: number
	fp: number
	fn: number
}

/**
 * Accumulate exact-match counts per tag. The caller owns inference so checks can choose their precise parse options
 * without duplicating the scoring implementation; `onRow` hands each row's predicted components back so a scorer can
 * run per-row diagnostics over the SAME parse the counts were taken from.
 */
export async function scorePerTagCounts(
	rows: readonly PerTagEvalRow[],
	tags: readonly string[],
	classify: (raw: string) => Promise<Record<string, string>>,
	onRow?: (row: PerTagEvalRow, predicted: Record<string, string>) => void
): Promise<Record<string, PerTagCounts>> {
	const statistics = Object.fromEntries(tags.map((tag) => [tag, { tp: 0, fp: 0, fn: 0 }]))

	for (const row of rows) {
		const predicted = await classify(row.raw)

		for (const tag of tags) {
			const expectedValue = normalizeComponent(row.components[tag])
			const predictedValue = normalizeComponent(predicted[tag])
			const statistic = statistics[tag]!

			if (expectedValue && predictedValue === expectedValue) {
				statistic.tp++
			} else {
				if (predictedValue) {
					statistic.fp++
				}

				if (expectedValue) {
					statistic.fn++
				}
			}
		}

		onRow?.(row, predicted)
	}

	return statistics
}

/**
 * One tag's rates, as fractions in [0, 1].
 */
export interface PerTagRates {
	p: number
	r: number
	f1: number
}

export function perTagRates(counts: PerTagCounts): PerTagRates {
	const { tp, fp, fn } = counts
	const p = tp + fp ? tp / (tp + fp) : 0
	const r = tp + fn ? tp / (tp + fn) : 0
	const f1 = p + r ? (2 * p * r) / (p + r) : 0

	return { p, r, f1 }
}

/**
 * Compute exact-match F1 percentages (one decimal, 0–100). The caller owns inference so checks can choose their precise
 * parse options without duplicating the scoring implementation.
 */
export async function scorePerTagF1(
	rows: readonly PerTagEvalRow[],
	tags: readonly string[],
	classify: (raw: string) => Promise<Record<string, string>>
): Promise<Record<string, number>> {
	const counts = await scorePerTagCounts(rows, tags, classify)

	return Object.fromEntries(tags.map((tag) => [tag, +(100 * perTagRates(counts[tag]!).f1).toFixed(1)]))
}

//#region Classifier construction

/**
 * Options for {@linkcode createUnfoldedEvalClassifier} — the classifier-construction block `score-affix` and
 * `score-country-homograph` carried byte-for-byte before it was shared.
 */
export interface UnfoldedEvalClassifierOptions {
	/**
	 * ONNX artifact to grade. Empty is legal alongside {@linkcode UnfoldedEvalClassifierOptions.weightsCache}.
	 */
	model: string
	/**
	 * PACKAGE-SHAPED (#718-safe): `<root>` loads model + tokenizer + card + ALL soft channels from the package via
	 * `loadFromWeights` — the only in-distribution grade for a country-channel model (v6.2.0+). Takes precedence over the
	 * explicit {@linkcode UnfoldedEvalClassifierOptions.model} path.
	 */
	weightsCache: string
	/**
	 * Gazetteer-anchor lexicon path; empty feeds nothing.
	 */
	gazetteerLexicon: string
	/**
	 * Feed the lexicon only when the path EXISTS on disk (the country probe's posture, harmless for older models) rather
	 * than whenever it is set (the affix scorer's, where a missing file should fail loudly).
	 */
	gazetteerLexiconWhenPresent?: boolean
	/**
	 * Suppress gazetteer clues adjacent to a postcode (paired with the lexicon feed).
	 */
	suppressGazNearPostcode: boolean
	/**
	 * #511 Tier A: `auto` | `<system>` enables the address-system conventions mask.
	 */
	conventions?: string
	/**
	 * V4.4.0 corrective: merge same-tag spans split at unlabeled punctuation.
	 */
	bridgeGaps?: boolean
}

/**
 * Build the classifier an unfolded per-tag scorer grades.
 */
export async function createUnfoldedEvalClassifier(
	options: UnfoldedEvalClassifierOptions
): Promise<NeuralAddressClassifier> {
	if (options.weightsCache) {
		return NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: options.weightsCache })
	}

	const tokenizerPath = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	const anchorLookupPath = dataRootPath("anchor", "pilot-anchor-lookup.json")
	const card = await readLocalJSONFile<{ labels: string[] }>("packages/neural-weights-en-us/model-card.json")

	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(tokenizerPath),
		ONNXRunner.create(options.model),
	])

	const feedGazetteerLexicon = options.gazetteerLexiconWhenPresent
		? await pathExists(options.gazetteerLexicon)
		: Boolean(options.gazetteerLexicon)

	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		postcodeAnchorLookup: parseAnchorLookup(await readLocalJSONFile(anchorLookupPath)),
		...(feedGazetteerLexicon
			? { gazetteerLexicon: parseGazetteerLexicon(await readLocalJSONFile(options.gazetteerLexicon)) }
			: {}),
		suppressGazetteerNearPostcode: options.suppressGazNearPostcode,
		...(options.conventions ? { addressSystemConventions: options.conventions as "auto" } : {}),
		...(options.bridgeGaps ? { bridgePunctuationGaps: true } : {}),
	})
}

//#endregion

//#region Conventions mask off/on battery

export interface LocaleEvalSpec {
	/**
	 * The codex address-system this locale maps to (`us`, `fr`, …).
	 */
	system: SystemCode
	/**
	 * Eval JSONL files (raw + components). Multiple files are concatenated.
	 */
	files: string[]
}

/**
 * One eval spec per locale that has an eval set, shared by the capability-manifest generator and the mask-regression
 * release check. The eval rows carry split street parts so the affix capability (`street_prefix`/`street_suffix`) is
 * measurable — the folded `per-locale-f1.ts` joins the three street parts and cannot see it. FR uses the dedicated
 * street-prefix slice (`fr-street-prefix-real.jsonl`, the #719 reproduction), NOT the broad golden dev set, for the
 * essential tags: golden FR carries only ~7 `street_prefix` rows against ~1535 without it, so the unfolded
 * `street_prefix` F1 there is dominated by absent-gold rows (measured 5.3) — it would UNDER-certify the very capability
 * the delta check exists to protect. On the purpose-built slice the model emits FR `street_prefix` at F1 80.0 (the
 * figure the #719 fix cites), which is the honest capability number the loader must guard.
 */
export const MASK_EVAL_LOCALES: LocaleEvalSpec[] = [
	{ system: "us", files: ["data/eval/golden/v0.1.2/dev/us.jsonl"] },
	{ system: "fr", files: ["data/eval/external/fr-street-prefix-real.jsonl"] },
]

/**
 * The artifacts a mask battery's scorers are built from — the keys `createScorer` reads.
 */
export interface MaskScorerArtifactPaths {
	modelPath: string
	tokenizerPath: string
	modelCardPath: string
	anchorLookupPath: string
	gazetteerLexiconPath: string
}

export interface MaskOffOnOptions {
	/**
	 * Serving-tier channel overrides layered under the conventions toggle (`{ gazetteer: false }` for the pocket tier).
	 */
	tierOverrides?: ScorerOverrides
	/**
	 * The parse mode the rows are graded in. Both callers — the capability-manifest generator and the mask-regression
	 * release check — pass `"formatted"`: the rows are formatted postal addresses, on which the production pipeline
	 * derives `formatted` and runs the evidence-bundle channels OFF as a declared ablation. Omitting it grades the
	 * bare-library default (`fragmented`), a path production does not take on these inputs; the option stays so a caller
	 * can measure that path on purpose, never by accident (#2048).
	 */
	inputMode?: "formatted"
}

/**
 * Score one locale's rows mask-OFF (conventions disabled — the model's raw capability; `createScorer` warns about the
 * declared-required override, which is expected) and mask-ON (conventions `auto`: locale-head detection applies the
 * detected system's `forbiddenTags` as a hard emission mask — the SHIP behavior whose damage the callers measure).
 *
 * Full SHIP-CONFIG otherwise (anchor-on + gazetteer-on — `createScorer`'s defaults, less any declared tier override).
 * Only the conventions channel toggles. `strict: true` fails closed if a declared channel can't be fed, so a
 * stale/incomplete feed surfaces loudly rather than silently grading a handicapped model.
 */
export async function scoreConventionsMaskOffOn(
	rows: readonly PerTagEvalRow[],
	tags: readonly string[],
	paths: MaskScorerArtifactPaths,
	options: MaskOffOnOptions = {}
): Promise<{ off: Record<string, number>; on: Record<string, number> }> {
	const base = { ...paths, strict: true as const }

	const classifyWith = (scorer: Awaited<ReturnType<typeof createScorer>>) => async (raw: string) => {
		const parsed = options.inputMode
			? await scorer.parse(raw, { inputMode: options.inputMode })
			: await scorer.parse(raw)

		return decodeAsJSON(parsed) as Record<string, string>
	}

	const offScorer = await createScorer({ ...base, overrides: { ...options.tierOverrides, conventions: false } })
	const off = await scorePerTagF1(rows, tags, classifyWith(offScorer))

	const onScorer = await createScorer({ ...base, overrides: { ...options.tierOverrides, conventions: "auto" } })
	const on = await scorePerTagF1(rows, tags, classifyWith(onScorer))

	return { off, on }
}

//#endregion
