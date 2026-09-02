/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Affix-aware per-tag scorer. `per-locale-f1`'s `foldToComponents` joins
 *   `street_prefix`+`street`+`street_suffix` into one `street`, so it CANNOT measure the affix
 *   split. This scores the UNFOLDED `decodeAsJSON` output against split ground truth: exact-match
 *   (case-insensitive) P/R/F1 per tag.
 *
 *   `promotion-eval.ts` calls this SIX times per battery — the affix set, `unit-real-designators`,
 *   `po-box-cedex-val`, `intersection-real`, and the two watch lenses (`intersection-golden-vt`,
 *   `glue-rows-perturb`) — capturing each report into its own `.md` and the machine-readable sidecar
 *   into its own `.json`. Every printed line goes through the `report` sink, one call per line, so
 *   the captured markdown is byte-identical to the child-process stdout it replaced.
 *   `scripts/eval/score-affix.ts` is the thin CLI that keeps standalone invocation working.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { JSONSpliterator } from "spliterator"

import {
	createUnfoldedEvalClassifier,
	type PerTagEvalRow,
	perTagRates,
	scorePerTagCounts,
} from "#eval-harness/per-tag-f1"

/**
 * Options for {@linkcode scoreAffix} — one field per flag the check used to serialize into argv.
 */
export interface ScoreAffixOptions {
	/**
	 * ONNX artifact to grade. Empty/omitted is legal alongside {@linkcode ScoreAffixOptions.weightsCache}. The value also
	 * feeds the report header verbatim (its last two path segments), so an empty string renders the same empty slot the
	 * child process did.
	 */
	model?: string
	/**
	 * Eval JSONL. Default `data/eval/external/street-affix-real.jsonl`.
	 */
	file?: string
	/**
	 * A gazetteer-trained model MUST be fed the lexicon (+ the paired postcode suppression) at inference, else the
	 * zero-filled clue is a train/inference mismatch that wrecks segmentation. Pass for v1.0.0+.
	 */
	gazetteerLexicon?: string
	/**
	 * Write the machine-readable sidecar here — the contract the check verdict reads. The markdown is presentation.
	 */
	json?: string
	/**
	 * #511 Tier A: `auto` | `<system>` enables the address-system conventions mask.
	 */
	conventions?: string
	/**
	 * V4.4.0 corrective: merge same-tag spans split at unlabeled punctuation.
	 */
	bridgeGaps?: boolean
	/**
	 * Suppress gazetteer clues adjacent to a postcode (paired with {@linkcode ScoreAffixOptions.gazetteerLexicon}).
	 */
	suppressGazNearPostcode?: boolean
	/**
	 * PACKAGE-SHAPED (#718-safe): `<root>` loads model + tokenizer + card + ALL soft channels (anchor + gazetteer +
	 * country) from the package via `loadFromWeights` — the only in-distribution grade for a country-channel model
	 * (v6.2.0+). Takes precedence over the explicit {@linkcode ScoreAffixOptions.model} path.
	 */
	weightsCache?: string
}

/**
 * One tag's exact-match counts and rates, as the JSON sidecar carries them.
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
 * What {@linkcode scoreAffix} returns — the same object written to the JSON sidecar, so a caller never has to re-read
 * the file it just asked for.
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
 * Score one eval file's UNFOLDED per-tag P/R/F1. Every narration line goes through `report`, one call per line, so the
 * check's captured markdown matches the child-process stdout it replaced byte-for-byte.
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
		suppressGazNearPostcode: options.suppressGazNearPostcode ?? false,
		...(options.conventions ? { conventions: options.conventions } : {}),
		...(options.bridgeGaps ? { bridgeGaps: true } : {}),
	})

	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<PerTagEvalRow>(file))

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
