/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures how many board rows' expected street receives paint from the `street_type` evidence
 *   lexicon, per country.
 *
 *   `data/gazetteer/street-type-lexicon-v3.json` is built from `@mailwoman/codex fr/us/gb/de/ca`, so
 *   the channel is silent on a street written with a street word from any other address system. A row
 *   whose street receives no paint gives the model a zero `street_type` feature over the real street,
 *   while a venue name leading with a covered word such as `Plaza` receives a positive one.
 *
 *   The scan is `gazetteerCharPaint`, the same function the classifier feeds, rather than a
 *   reimplementation of the artifact's `word_norm` and n-gram rules.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/street/type/lexicon-coverage.run.ts [--show 20] [--json <out>]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { gazetteerCharPaint, parseGazetteerLexicon } from "@mailwoman/neural/gazetteer-inference"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: {
		show: { type: "string", description: "How many unpainted streets to print (default 20)" },
		json: { type: "string", description: "Write the per-row verdicts to this path" },
	},
})

const show = Number(values.show ?? 20)

if (!Number.isFinite(show) || show < 0) throw new Error(`--show must be a non-negative number, read ${values.show}`)

const lexiconPath = repoRootPathBuilder("data", "gazetteer", "street-type-lexicon-v3.json")
const raw = await readLocalJSONFile<Parameters<typeof parseGazetteerLexicon>[0]>(lexiconPath)
const lexicon = parseGazetteerLexicon(raw)

interface Verdict {
	id: string
	country: string
	street: string
	paintedChars: number
}

const verdicts: Verdict[] = []
let noStreet = 0

for (const seed of await loadRegressionCases()) {
	const street = seed.expectComponents?.street

	if (!street) {
		noStreet++

		continue
	}

	const painted = gazetteerCharPaint(street, lexicon).filter((bits) => bits !== 0).length

	verdicts.push({ id: seed.id, country: (seed.country ?? "").toUpperCase(), street, paintedChars: painted })
}

const painted = verdicts.filter((verdict) => verdict.paintedChars > 0)

console.log(`lexicon: ${raw.entries ? Object.keys(raw.entries).length : 0} entries, generated_by:`)
console.log(`  ${(raw as { generated_by?: string }).generated_by ?? "(unstated)"}`)
console.log(`\nboard rows expecting a street: ${verdicts.length}  (rows with no expected street: ${noStreet})`)
console.log(
	`  street carrying any street_type paint: ${painted.length}` +
		(verdicts.length ? `  (${((painted.length / verdicts.length) * 100).toFixed(1)}%)` : "")
)

const byCountry = new Map<string, { rows: number; painted: number }>()

for (const verdict of verdicts) {
	const entry = byCountry.get(verdict.country) ?? { rows: 0, painted: 0 }

	entry.rows++

	if (verdict.paintedChars > 0) {
		entry.painted++
	}

	byCountry.set(verdict.country, entry)
}

console.log(`\nper country:`)

for (const [code, entry] of [...byCountry].toSorted((a, b) => b[1].rows - a[1].rows)) {
	console.log(
		`  ${code}  ${entry.painted} of ${entry.rows} painted  ${((entry.painted / entry.rows) * 100).toFixed(0)}%`
	)
}

const unpainted = verdicts.filter((verdict) => verdict.paintedChars === 0)

console.log(`\nfirst ${Math.min(show, unpainted.length)} of ${unpainted.length} streets the channel is silent on:`)

for (const verdict of unpainted.slice(0, show)) {
	console.log(`  ${verdict.country}  ${verdict.street}   (${verdict.id})`)
}

if (values.json) {
	const { writeLocalJSONFile } = await import("@mailwoman/core/fs/writers")

	await writeLocalJSONFile(
		{
			lexicon: lexiconPath.toString(),
			rows: verdicts.length,
			painted: painted.length,
			byCountry: [...byCountry].map(([country, entry]) => ({ country, ...entry })),
			verdicts,
		},
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
