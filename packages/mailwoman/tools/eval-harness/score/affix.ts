/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Affix-aware per-tag scorer. `per-locale-f1`'s `foldToComponents` joins
 *   `street_prefix`+`street`+`street_suffix` into one `street`, so it cannot measure the affix
 *   split. This scores the unfolded `decodeAsJSON` output against split ground truth: exact-match
 *   (case-insensitive) P/R/F1 per tag.
 *
 *   Every printed line goes through the `report` sink, one call per line, so a caller can capture the
 *   report as markdown.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { type AddressSystemConventions, DEFAULT_TOGGLE, type Toggle } from "@mailwoman/neural/classifier/options"
import { JSONSpliterator } from "spliterator"

import {
	createUnfoldedEvalClassifier,
	type PerTagEvalRow,
	perTagRates,
	scorePerTagCounts,
} from "#tools/eval-harness/per/tag-f1"

/**
 * Options for {@linkcode scoreAffix}.
 */
export interface ScoreAffixOptions {
	/**
	 * ONNX artifact to grade.
	 *
	 * Empty or omitted is legal alongside {@linkcode ScoreAffixOptions.weightsCache}.
	 */
	model?: string
	/**
	 * Eval jsonl.
	 *
	 * Default `data/eval/external/street-affix-real.jsonl`.
	 */
	file?: string
	/**
	 * A gazetteer-trained model must be fed the lexicon (+ the paired postcode suppression) at
	 * inference, else the zero-filled clue is a train/inference mismatch that wrecks segmentation.
	 *
	 * Pass for v1.0.0+.
	 */
	gazetteerLexicon?: string
	/**
	 * Write the machine-readable sidecar here.
	 * The check verdict reads this file.
	 */
	json?: string
	/**
	 * `auto` or `<system>` enables the address-system conventions mask.
	 * It defaults to `"off"`.
	 */
	conventions?: AddressSystemConventions
	/**
	 * Merge same-tag spans split at unlabeled punctuation.
	 * It defaults to {@linkcode DEFAULT_TOGGLE}.
	 */
	bridgePunctuationGaps?: Toggle
	/**
	 * Suppress gazetteer clues adjacent to a postcode
	 * (paired with {@linkcode ScoreAffixOptions.gazetteerLexicon}).
	 * It defaults to {@linkcode DEFAULT_TOGGLE}.
	 */
	suppressGazetteerNearPostcode?: Toggle
	/**
	 * Package-shaped `<root>` loads model + tokenizer + card + all soft channels
	 * (anchor + gazetteer + country) from the package via `loadFromWeights`.
	 *
	 * The only in-distribution grade for a country-channel model (v6.2.0+).
	 *
	 * Takes precedence over the explicit {@linkcode ScoreAffixOptions.model} path.
	 */
	weightsCache?: string
}

/**
 * One tag's exact-match counts and rates, as recorded in the JSON sidecar.
 */
export interface ScoreAffixTag {
	p: number
	r: number
	f1: number
	tp: number
	fp: number
	fn: number
}

/**
 * What {@linkcode scoreAffix} returns.
 *
 * The same object written to the JSON sidecar, so a caller never has to re-read the file it just asked for.
 */
export interface ScoreAffixResult {
	n: number
	file: string
	tags: Record<string, ScoreAffixTag>
}

const TAGS = [
	"street_prefix",
	"street",
	"street_suffix",
	"house_number",
	"locality",
	"region",
	"postcode",
	"unit",
	"intersection_a",
	"intersection_b",
	"po_box",
	"cedex",
] as const

/**
 * Score one eval file's unfolded per-tag P/R/F1.
 *
 * Every narration line goes through `report`, one call per line.
 */
export async function scoreAffix(
	options: ScoreAffixOptions = {},
	report: (line: string) => void = console.log
): Promise<ScoreAffixResult> {
	const file = options.file || "data/eval/external/street-affix-real.jsonl"
	const model = options.model || ""

	const neural = await createUnfoldedEvalClassifier({
		model,
		weightsCache: options.weightsCache || "",
		gazetteerLexicon: options.gazetteerLexicon || "",
		suppressGazetteerNearPostcode: options.suppressGazetteerNearPostcode ?? DEFAULT_TOGGLE,
		conventions: options.conventions ?? "off",
		bridgePunctuationGaps: options.bridgePunctuationGaps ?? DEFAULT_TOGGLE,
	})

	const rows = await JSONSpliterator.fromAsync<PerTagEvalRow>(file).toArray()

	const stat = await scorePerTagCounts(
		rows,
		TAGS,
		async (raw) => decodeAsJSON(await neural.parse(raw)) as Record<string, string>
	)

	report(`# affix per-tag (unfolded) — ${model.split("/").slice(-2).join("/")} · n=${rows.length}`)
	report("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")

	const sidecar: Record<string, ScoreAffixTag> = {}

	for (const t of TAGS) {
		const { tp, fp, fn } = stat[t]!
		const { p, r, f1 } = perTagRates(stat[t]!)
		sidecar[t] = { p: +(100 * p).toFixed(1), r: +(100 * r).toFixed(1), f1: +(100 * f1).toFixed(1), tp, fp, fn }

		report(
			`| ${t} | ${(100 * p).toFixed(1)} | ${(100 * r).toFixed(1)} | ${(100 * f1).toFixed(1)} | ${tp}/${fp}/${fn} |`
		)
	}

	const result: ScoreAffixResult = { n: rows.length, file, tags: sidecar }

	if (options.json) {
		await writeLocalJSONFile(result, options.json)
	}

	return result
}
