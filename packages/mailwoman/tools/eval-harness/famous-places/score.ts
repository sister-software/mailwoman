// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Scores the frozen famous-places test set: national capitals, landmarks and natural features, each written bare,
 *   with its country and in a local language. A capital expects `locality` and every other place expects `venue`.
 *
 *   A model may have trained on these places, so the set measures recall of known places. An entity-level holdout
 *   measures unseen places, and the two are reported apart.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"

import { createUnfoldedEvalClassifier, perTagRates, scorePerTagCounts } from "#tools/eval-harness/per/tag-f1"
import { productionPriorOptions } from "#tools/eval-harness/production-priors"
import type { ScoreAffixOptions } from "#tools/eval-harness/score/affix"

/**
 * The frozen fixture this scorer reads by default, committed beside it.
 */
export const FAMOUS_PLACES_FIXTURE = resolvePackageDirectory("mailwoman")(
	"tools",
	"eval-harness",
	"famous-places",
	"famous-places.v0.jsonl"
).toString()

/**
 * The tags the scorer counts: the two a famous place expects, and the ones a misread name lands in.
 */
export const FAMOUS_PLACES_TAGS = [
	"venue",
	"locality",
	"region",
	"country",
	"street",
	"street_suffix",
	"dependent_locality",
] as const

/**
 * One fixture row.
 */
export interface FamousPlaceRow {
	input: string
	components: Record<string, string>
	/**
	 * The Wikidata item the row names.
	 */
	qid: string
	/**
	 * The group the entity was selected from: `capital`, `landmark`, `national-park` and so on.
	 */
	kind: string
	/**
	 * How the name is written: `en` bare, `en-country` with its country, `local` in a local language.
	 */
	form: string
	country: string | null
	lat: number
	lon: number
	tolerance_m: number
}

/**
 * The share of rows whose parse equals the expected components, overall and per kind and form.
 */
export interface FamousPlacesResult {
	n: number
	file: string
	exact: { pass: number; n: number }
	exactByKindForm: Record<string, { pass: number; n: number }>
	tags: Record<string, { p: number; r: number; f1: number; tp: number; fp: number; fn: number }>
}

/**
 * Whether a parse names exactly the expected components with the expected values, compared case-folded.
 */
export function matchesExpectedComponents(
	expected: Record<string, string>,
	predicted: Record<string, string>
): boolean {
	const fold = (value: string) => value.normalize("NFKC").toLowerCase().trim()
	const keys = Object.keys(expected).toSorted()

	if (keys.join("+") !== Object.keys(predicted).toSorted().join("+")) return false

	return keys.every((key) => fold(predicted[key] ?? "") === fold(expected[key]!))
}

/**
 * Score the famous-places fixture on one model, parsing each row with its own country's priors.
 *
 * Every narration line goes through `report`, one call per line.
 */
export async function scoreFamousPlaces(
	options: Pick<ScoreAffixOptions, "model" | "weightsCache" | "json"> & { file?: string } = {},
	report: (line: string) => void = console.log
): Promise<FamousPlacesResult> {
	const file = options.file || FAMOUS_PLACES_FIXTURE
	const fixture = await JSONSpliterator.fromAsync<FamousPlaceRow>(file).toArray()
	const rows = fixture.map((row) => ({ ...row, raw: row.input }))
	const byInput = new Map(rows.map((row) => [row.raw, row]))

	const neural = await createUnfoldedEvalClassifier({
		model: options.model || "",
		weightsCache: options.weightsCache || "",
		gazetteerLexicon: "",
		suppressGazetteerNearPostcode: "off",
		conventions: "off",
		bridgePunctuationGaps: "off",
	})

	const priors = await productionPriorOptions(neural)
	const exactByKindForm: Record<string, { pass: number; n: number }> = {}
	let pass = 0

	const counts = await scorePerTagCounts(
		rows,
		FAMOUS_PLACES_TAGS,
		async (raw) =>
			decodeAsJSON(await neural.parse(raw, priors(byInput.get(raw)?.country ?? null))) as Record<string, string>,
		(row, predicted) => {
			const fixtureRow = byInput.get(row.raw)!
			const key = `${fixtureRow.kind}/${fixtureRow.form}`
			const cell = (exactByKindForm[key] ??= { pass: 0, n: 0 })
			const ok = matchesExpectedComponents(fixtureRow.components, predicted)

			cell.n++

			if (ok) {
				cell.pass++

				pass++
			}
		}
	)

	const tags: FamousPlacesResult["tags"] = {}

	for (const tag of FAMOUS_PLACES_TAGS) {
		const { p, r, f1 } = perTagRates(counts[tag]!)
		tags[tag] = { p: +(100 * p).toFixed(1), r: +(100 * r).toFixed(1), f1: +(100 * f1).toFixed(1), ...counts[tag]! }
	}

	report(`# famous places — n=${rows.length}, exact ${pass}/${rows.length}`)
	report("| kind/form | exact | n |\n| --- | --: | --: |")

	for (const [key, cell] of Object.entries(exactByKindForm).toSorted(([a], [b]) => a.localeCompare(b))) {
		report(`| ${key} | ${cell.pass} | ${cell.n} |`)
	}

	report("| tag | P | R | F1 |\n| --- | --: | --: | --: |")

	for (const [tag, rate] of Object.entries(tags)) {
		report(`| ${tag} | ${rate.p} | ${rate.r} | ${rate.f1} |`)
	}

	const result: FamousPlacesResult = { n: rows.length, file, exact: { pass, n: rows.length }, exactByKindForm, tags }

	if (options.json) {
		await writeLocalJSONFile(result, options.json)
	}

	return result
}
