/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country homograph scorer — the TRUE baseline for the model-first country lever. Measures
 *   country/region/locality P/R/F1 (unfolded `decodeAsJSON`) on the hard homograph eval, PLUS the
 *   over-fire confusion: how often a gold region/locality span is mistagged as `country` (the
 *   "trailing token = country" failure), and how often gold country is missed.
 *
 *   The promotion gate calls this once per battery and captures the report into
 *   `<out-dir>/<tag>-country.md`, with the machine-readable sidecar at `<tag>-country.json` (the
 *   verdict reads `tags.country.f1` from it). Every printed line goes through the `report` sink, one
 *   call per line, so the captured markdown is byte-identical to the child stdout it replaced.
 *   `scripts/eval/score-country-homograph.ts` is the thin CLI that keeps standalone invocation
 *   working.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { JSONSpliterator } from "spliterator"

/**
 * Options for {@linkcode scoreCountryHomograph} — one field per flag the gate used to serialize into argv.
 */
export interface ScoreCountryHomographOptions {
	/**
	 * ONNX artifact to grade. Empty/omitted is legal alongside {@linkcode ScoreCountryHomographOptions.weightsCache}; the
	 * value also feeds the report header verbatim (its last path segment), so an empty string renders the same empty slot
	 * the child process did.
	 */
	model?: string
	/**
	 * Eval JSONL. Default `data/eval/external/country-homograph-real.jsonl`.
	 */
	file?: string
	/**
	 * Gazetteer-anchor lexicon (#464): fed when the path EXISTS so a gazetteer-trained model (v0.9.12+) gets its
	 * candidate-tag clues; harmless for older models (the runner skips inputs the ONNX doesn't declare). Unlike
	 * `score-affix`, this probe defaults the path to `data/gazetteer/anchor-lexicon-v1.json` rather than off.
	 */
	gazetteerLexicon?: string
	/**
	 * Write the machine-readable sidecar here — the contract the gate verdict reads.
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
	 * Suppress gazetteer clues adjacent to a postcode. The gate always passes this for the country probe — zero-filled
	 * clues near a postcode depress country recall.
	 */
	suppressGazNearPostcode?: boolean
	/**
	 * PACKAGE-SHAPED (#718-safe): `<root>` loads model + tokenizer + card + ALL soft channels (anchor + gazetteer +
	 * country) from the package via `loadFromWeights` — the only in-distribution grade for a country-channel model
	 * (v6.2.0+), which is exactly what this country probe must feed. Precedence over
	 * {@linkcode ScoreCountryHomographOptions.model}.
	 */
	weightsCache?: string
}

/**
 * One tag's exact-match counts and rates, as the JSON sidecar carries them.
 */
export interface CountryHomographTag {
	p: number
	r: number
	f1: number
	tp: number
	fp: number
	fn: number
}

/**
 * What {@linkcode scoreCountryHomograph} returns — the same object written to the JSON sidecar.
 */
export interface ScoreCountryHomographResult {
	n: number
	file: string
	tags: Record<string, CountryHomographTag>
	/**
	 * Gold region/locality spans the model emitted as `country` (the "trailing token = country" failure).
	 */
	overfire: number
	/**
	 * Rows carrying a gold country where the model emitted none.
	 */
	missedCountry: number
}

const TAGS = ["country", "region", "locality"] as const

/**
 * Score the country-homograph battery. Every narration line goes through `report`, one call per line, so the gate's
 * captured markdown matches the child-process stdout it replaced byte-for-byte.
 */
export async function scoreCountryHomograph(
	options: ScoreCountryHomographOptions = {},
	report: (line: string) => void = console.log
): Promise<ScoreCountryHomographResult> {
	const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
	const GAZ = options.gazetteerLexicon || "data/gazetteer/anchor-lexicon-v1.json"
	const file = options.file || "data/eval/external/country-homograph-real.jsonl"
	const model = options.model || ""
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
					...(existsSync(GAZ)
						? { gazetteerLexicon: parseGazetteerLexicon(parseJSONStrict(readFileSync(GAZ, "utf8"))) }
						: {}),
					suppressGazetteerNearPostcode: options.suppressGazNearPostcode ?? false,
					// #511 Tier A: `conventions` auto|<system> enables the address-system conventions mask.
					...(options.conventions ? { addressSystemConventions: options.conventions as "auto" } : {}),
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

	// over-fire diagnostics
	let overfire = 0 // gold region/locality token tagged as country
	let missedCountry = 0 // gold country present, model emitted no country
	const overfireCases: string[] = []
	const missedCases: string[] = []

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

		// over-fire: model emitted a country that is actually the gold region or locality
		const gc = norm(got.country)

		if (gc && !norm(exp.country) && (gc === norm(exp.region) || gc === norm(exp.locality))) {
			overfire++

			overfireCases.push(
				`  ${row.raw}  → country="${got.country}" (gold ${norm(exp.region) === gc ? "region" : "locality"})`
			)
		}

		if (norm(exp.country) && !gc) {
			missedCountry++
			missedCases.push(`  ${row.raw}  → no country emitted (gold "${exp.country}")`)
		}
	}

	report(`# country homograph baseline — ${model.split("/").at(-1)} · n=${rows.length}`)

	const sidecar: Record<string, CountryHomographTag> = {}

	report("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")

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

	const result: ScoreCountryHomographResult = { n: rows.length, file, tags: sidecar, overfire, missedCountry }

	if (options.json) {
		writeFileSync(options.json, JSON.stringify(result, null, "\t") + "\n")
	}

	report(`\nover-fire (region/locality tagged as country): ${overfire}`)
	report(`missed country (gold country, none emitted): ${missedCountry}`)

	if (overfireCases.length) {
		report("\n-- over-fire cases --\n" + overfireCases.join("\n"))
	}

	if (missedCases.length) {
		report("\n-- missed-country cases --\n" + missedCases.join("\n"))
	}

	return result
}
