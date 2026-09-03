/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country homograph scorer — the TRUE baseline for the model-first country change. Measures
 *   country/region/locality P/R/F1 (unfolded `decodeAsJSON`) on the hard homograph eval, PLUS the
 *   over-fire confusion: how often a gold region/locality span is mistagged as `country` (the
 *   "trailing token = country" failure), and how often gold country is missed.
 *
 *   `promotion-eval.ts` calls this once per battery and captures the report into
 *   `<out-dir>/<tag>-country.md`, with the machine-readable sidecar at `<tag>-country.json` (the
 *   verdict reads `tags.country.f1` from it). Every printed line goes through the `report` sink, one
 *   call per line, so the captured markdown is byte-identical to the child stdout it replaced.
 *   `scripts/eval/score-country-homograph.ts` is the thin CLI that keeps standalone invocation
 *   working.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { JSONSpliterator } from "spliterator"

import {
	createUnfoldedEvalClassifier,
	normalizeComponent,
	type PerTagEvalRow,
	perTagRates,
	scorePerTagCounts,
} from "#eval-harness/per-tag-f1"

/**
 * Options for {@linkcode scoreCountryHomograph} — one field per flag the check used to serialize into argv.
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
	 * Write the machine-readable sidecar here — the contract the check verdict reads.
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
	 * Suppress gazetteer clues adjacent to a postcode. The check always passes this for the country probe — zero-filled
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
 * Score the country-homograph battery. Every narration line goes through `report`, one call per line, so the check's
 * captured markdown matches the child-process stdout it replaced byte-for-byte.
 */
export async function scoreCountryHomograph(
	options: ScoreCountryHomographOptions = {},
	report: (line: string) => void = console.log
): Promise<ScoreCountryHomographResult> {
	const file = options.file || "data/eval/external/country-homograph-real.jsonl"
	const model = options.model || ""

	const neural = await createUnfoldedEvalClassifier({
		model,
		weightsCache: options.weightsCache || "",
		gazetteerLexicon: options.gazetteerLexicon || "data/gazetteer/anchor-lexicon-v1.json",
		gazetteerLexiconWhenPresent: true,
		suppressGazNearPostcode: options.suppressGazNearPostcode ?? false,
		...(options.conventions ? { conventions: options.conventions } : {}),
		...(options.bridgeGaps ? { bridgeGaps: true } : {}),
	})

	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<PerTagEvalRow>(file))

	// over-fire diagnostics
	let overfire = 0 // gold region/locality token tagged as country
	let missedCountry = 0 // gold country present, model emitted no country
	const overfireCases: string[] = []
	const missedCases: string[] = []

	const stat = await scorePerTagCounts(
		rows,
		TAGS,
		async (raw) => decodeAsJSON(await neural.parse(raw)) as Record<string, string>,
		(row, got) => {
			const exp = row.components

			// over-fire: model emitted a country that is actually the gold region or locality
			const gc = normalizeComponent(got.country)

			if (
				gc &&
				!normalizeComponent(exp.country) &&
				(gc === normalizeComponent(exp.region) || gc === normalizeComponent(exp.locality))
			) {
				overfire++

				overfireCases.push(
					`  ${row.raw}  → country="${got.country}" (gold ${normalizeComponent(exp.region) === gc ? "region" : "locality"})`
				)
			}

			if (normalizeComponent(exp.country) && !gc) {
				missedCountry++
				missedCases.push(`  ${row.raw}  → no country emitted (gold "${exp.country}")`)
			}
		}
	)

	report(`# country homograph baseline — ${model.split("/").at(-1)} · n=${rows.length}`)

	const sidecar: Record<string, CountryHomographTag> = {}

	report("| tag | P | R | F1 | tp/fp/fn |\n| --- | --: | --: | --: | --- |")

	for (const t of TAGS) {
		const { tp, fp, fn } = stat[t]!
		const { p, r, f1 } = perTagRates(stat[t]!)
		sidecar[t] = { p: +(100 * p).toFixed(1), r: +(100 * r).toFixed(1), f1: +(100 * f1).toFixed(1), tp, fp, fn }

		report(
			`| ${t} | ${(100 * p).toFixed(1)} | ${(100 * r).toFixed(1)} | ${(100 * f1).toFixed(1)} | ${tp}/${fp}/${fn} |`
		)
	}

	const result: ScoreCountryHomographResult = { n: rows.length, file, tags: sidecar, overfire, missedCountry }

	if (options.json) {
		await writeLocalJSONFile(result, options.json)
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
