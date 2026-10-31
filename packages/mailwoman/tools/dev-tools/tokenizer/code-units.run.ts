/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures the code-unit arm (#2845) on a corpus split: code units per address and the share where a
 *   house-number or postcode span is exactly one unit, and how well a unit's shape separates the two.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/tokenizer/code-units.run.ts --manifest <MANIFEST.json>
 *   [--rows 200000] [--out <report.json>]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { openCorpusRowStream } from "@mailwoman/corpus/parquet/corpus-rows"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { codeUnitPattern, segmentCodeUnits } from "@mailwoman/mtf/code-units"
import { acceptPostcode, countriesAcceptingPostcode } from "@mailwoman/postcode/country-formats"

const { values } = parseArguments({
	options: {
		manifest: { type: "string", description: "Corpus MANIFEST.json" },
		rows: { type: "string", default: "200000", description: "Rows to read" },
		out: { type: "string", description: "Report JSON path" },
	},
})

if (!values.manifest) throw new Error("--manifest is required")

const rowLimit = Number(values.rows)
const manifest = await readLocalJSONFile<object>(values.manifest)
// A corpus whose files hold every split assigns rows through split attributes.
// A unit's shape does not depend on the split, so every listed file is read.
const files = baseManifestFiles<{ path: string }>(manifest).map((file) => localManifestFilePath(file.path))

if (!files.length) throw new Error(`${values.manifest} lists no file`)

// Each file holds one source, so the budget is spread evenly across files rather than read from the first one.
const perFile = Math.max(1, Math.ceil(rowLimit / files.length))

/**
 * The tags whose units the separability question is about.
 */
const TARGET_TAGS = ["house_number", "postcode"] as const

type TargetTag = (typeof TARGET_TAGS)[number]

let rows = 0
let units = 0
const unitsPerRow = new Map<number, number>()

const spans: Record<TargetTag, { total: number; oneUnit: number }> = {
	house_number: { total: 0, oneUnit: 0 },
	postcode: { total: 0, oneUnit: 0 },
}

// Each unit wholly covering one target span, keyed by its features.
const byPattern = new Map<string, Record<TargetTag, number>>()
const byFeatures = new Map<string, Record<TargetTag, number>>()
let acceptedForRowCountry = 0
let targetUnits = 0

const tally = (table: Map<string, Record<TargetTag, number>>, key: string, tag: TargetTag) => {
	const counts = table.get(key) ?? { house_number: 0, postcode: 0 }

	counts[tag]++
	table.set(key, counts)
}

for (const file of files) {
	let read = 0

	for await (const row of openCorpusRowStream<{
		raw: string
		country: string
		span_starts: number[]
		span_ends: number[]
		span_tags: string[]
	}>(file, { columns: ["raw", "country", "span_starts", "span_ends", "span_tags"] })) {
		if (read >= perFile) break

		read++

		rows++

		const found = segmentCodeUnits(row.raw)
		units += found.length
		unitsPerRow.set(found.length, (unitsPerRow.get(found.length) ?? 0) + 1)

		for (const [index, tag] of row.span_tags.entries()) {
			if (tag !== "house_number" && tag !== "postcode") continue

			const start = row.span_starts[index]!
			const end = row.span_ends[index]!
			const inside = found.filter((unit) => unit.start >= start && unit.end <= end)

			spans[tag].total++

			if (inside.length !== 1 || inside[0]!.start !== start || inside[0]!.end !== end) continue

			spans[tag].oneUnit++

			targetUnits++

			const unit = inside[0]!.text
			const pattern = codeUnitPattern(unit)
			const accepted = acceptPostcode(unit, row.country) !== null

			if (accepted) {
				acceptedForRowCountry++
			}

			tally(byPattern, pattern, tag)
			tally(byFeatures, `${pattern}\u0000${accepted}\u0000${Math.min(countriesAcceptingPostcode(unit).length, 9)}`, tag)
		}
	}
}

/**
 * The share of target units a majority-label rule over `table`'s keys labels correctly.
 */
const majorityAccuracy = (table: Map<string, Record<TargetTag, number>>) => {
	let correct = 0

	for (const counts of table.values()) {
		correct += Math.max(counts.house_number, counts.postcode)
	}

	return targetUnits ? correct / targetUnits : null
}

const report = {
	manifest: values.manifest,
	files: files.length,
	rowsPerFile: perFile,
	rows,
	units,
	unitsPerRow: Object.fromEntries([...unitsPerRow].toSorted(([a], [b]) => a - b)),
	spansThatAreOneUnit: Object.fromEntries(
		TARGET_TAGS.map((tag) => [
			tag,
			{ ...spans[tag], share: spans[tag].total ? spans[tag].oneUnit / spans[tag].total : null },
		])
	),
	targetUnits,
	acceptedByRowCountry: targetUnits ? acceptedForRowCountry / targetUnits : null,
	separability: {
		patternOnly: majorityAccuracy(byPattern),
		patternAcceptanceAndCountryCount: majorityAccuracy(byFeatures),
		distinctPatterns: byPattern.size,
	},
	topPatterns: [...byPattern]
		.toSorted(([, a], [, b]) => b.house_number + b.postcode - (a.house_number + a.postcode))
		.slice(0, 25)
		.map(([pattern, counts]) => ({ pattern, ...counts })),
}

console.log(prettyJSON(report))

if (values.out) {
	await writeLocalJSONFile(report, values.out)
}
