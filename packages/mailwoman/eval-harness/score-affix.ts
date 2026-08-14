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
 *   The promotion gate calls this SIX times per battery — the affix set, `unit-real-designators`,
 *   `po-box-cedex-val`, `intersection-real`, and the two watch lenses (`intersection-golden-vt`,
 *   `glue-rows-perturb`) — capturing each report into its own `.md` and the machine-readable sidecar
 *   into its own `.json`. Every printed line goes through the `report` sink, one call per line, so
 *   the captured markdown is byte-identical to the child-process stdout it replaced.
 *   `scripts/eval/score-affix.ts` is the thin CLI that keeps standalone invocation working.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { JSONSpliterator } from "spliterator"

/**
 * Options for {@linkcode scoreAffix} — one field per flag the gate used to serialize into argv.
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
	 * Write the machine-readable sidecar here — the contract the gate verdict reads. The markdown is presentation.
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
 * gate's captured markdown matches the child-process stdout it replaced byte-for-byte.
 */
export async function scoreAffix(
	options: ScoreAffixOptions = {},
	report: (line: string) => void = console.log
): Promise<ScoreAffixResult> {
	const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
	const file = options.file || "data/eval/external/street-affix-real.jsonl"
	const model = options.model || ""
	const GAZ = options.gazetteerLexicon || ""
	const suppressGaz = options.suppressGazNearPostcode ?? false
	const WEIGHTS_CACHE = options.weightsCache || ""

	const neural = WEIGHTS_CACHE
		? await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", cacheRoot: WEIGHTS_CACHE })
		: await (async () => {
				const card = parseJSONStrict<{ labels: string[] }>(readFileSync("neural-weights-en-us/model-card.json", "utf8"))

				const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), ONNXRunner.create(model)])

				return new NeuralAddressClassifier({
					tokenizer,
					runner,
					labels: card.labels,
					postcodeAnchorLookup: parseAnchorLookup(parseJSONStrict(readFileSync(LK, "utf8"))),
					...(GAZ ? { gazetteerLexicon: parseGazetteerLexicon(parseJSONStrict(readFileSync(GAZ, "utf8"))) } : {}),
					suppressGazetteerNearPostcode: suppressGaz,
					// #511 Tier A: `conventions` auto|<system> enables the address-system conventions mask.
					...(options.conventions ? { addressSystemConventions: options.conventions as "auto" } : {}),
					// v4.4.0 corrective: `bridgeGaps` merges same-tag spans split at unlabeled punctuation.
					...(options.bridgeGaps ? { bridgePunctuationGaps: true } : {}),
				})
			})()

	const rows = await Array.fromAsync(
		JSONSpliterator.fromAsync<{ raw: string; components: Record<string, string> }>(file)
	)

	const norm = (s?: string): string => (s ?? "").trim().toLowerCase()
	const stat: Record<string, { tp: number; fp: number; fn: number }> = {}

	for (const t of TAGS) {
		stat[t] = { tp: 0, fp: 0, fn: 0 }
	}

	for (const row of rows) {
		const got = decodeAsJSON(await neural.parse(row.raw)) as Record<string, string>
		const exp = row.components as Record<string, string>

		for (const t of TAGS) {
			const e = norm(exp[t]),
				g = norm(got[t])

			if (e && g && e === g) {
				stat[t]!.tp++
			} else {
				if (g) {
					stat[t]!.fp++
				}

				if (e) {
					stat[t]!.fn++
				}
			}
		}
	}

	report(`# affix per-tag (unfolded) — ${model.split("/").slice(-2).join("/")} · n=${rows.length}`)
	report("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")

	const sidecar: Record<string, ScoreAffixTag> = {}

	for (const t of TAGS) {
		const { tp, fp, fn } = stat[t]!
		const p = tp + fp ? tp / (tp + fp) : 0
		const r = tp + fn ? tp / (tp + fn) : 0
		const f1 = p + r ? (2 * p * r) / (p + r) : 0
		sidecar[t] = { p: +(100 * p).toFixed(1), r: +(100 * r).toFixed(1), f1: +(100 * f1).toFixed(1), tp, fp, fn }

		report(
			`| ${t} | ${(100 * p).toFixed(1)} | ${(100 * r).toFixed(1)} | ${(100 * f1).toFixed(1)} | ${tp}/${fp}/${fn} |`
		)
	}

	const result: ScoreAffixResult = { n: rows.length, file, tags: sidecar }

	if (options.json) {
		writeFileSync(options.json, JSON.stringify(result, null, "\t") + "\n")
	}

	return result
}
