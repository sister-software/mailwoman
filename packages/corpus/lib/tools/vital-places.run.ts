/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the `wikidata-vital-places` parquet part and its entity holdout from a fetched inventory.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/vital-places.run.ts --out <dir> --source-root <fetch root> [--exempt <jsonl>]
 *
 *   `--source-root` is the `--out` root `mailwoman corpus fetch wikidata-vital-places` wrote under.
 *   `--exempt` is a JSONL file with a `qid` on each row. Those entities always train.
 *   The part goes to `<out>/wikidata-vital-places-00000.parquet`, and the holdout and counts beside it.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PathBuilder, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { rowToParquet, type ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { VITAL_PLACES_FILES, vitalPlacesPath } from "#tools/fetch/wikidata/vital-places"
import type { ClassRoots } from "#tools/fetch/wikidata/vital-places/classify"
import type { VitalPlace } from "#tools/fetch/wikidata/vital-places/inventory"
import { renderVitalPlaces, VITAL_PLACES_SOURCE } from "#tools/fetch/wikidata/vital-places/render"
import { alignRow } from "#utils/align"

const { values } = parseArguments({
	options: {
		out: { type: "string" },
		"source-root": { type: "string" },
		exempt: { type: "string" },
	},
})

if (!values.out) throw new Error("--out names the directory the part is written to")

if (!values["source-root"]) throw new Error("--source-root names the fetch's --out root, such as <data root>/corpus/sources")

const out = PathBuilder.from(resolvePath(values.out as string))
const sourceDir = vitalPlacesPath(PathBuilder.from(resolvePath(values["source-root"] as string)))
const rootsPath = sourceDir(VITAL_PLACES_FILES.classRoots)

if (!(await pathExists(rootsPath))) {
	throw new Error(`${rootsPath.toString()} is missing; run the fetch so every class is asked about the render's roots`)
}

const roots = await readLocalJSONFile<ClassRoots>(rootsPath)
const places = await JSONSpliterator.fromAsync<VitalPlace>(sourceDir(VITAL_PLACES_FILES.places)).toArray()

const exempt = new Set(
	values.exempt
		? (await JSONSpliterator.fromAsync<{ qid: string }>(resolvePath(values.exempt as string)).toArray()).map(
				(row) => row.qid
			)
		: []
)

const render = renderVitalPlaces(places, roots, exempt)
const rows: ParquetRow[] = []
const quarantined: string[] = []

for (const row of render.rows) {
	const aligned = alignRow({ ...row, license: "CC0-1.0", surface: "rendered" } as unknown as Parameters<typeof alignRow>[0])

	if (aligned.kind !== "labeled") {
		quarantined.push(row.source_id)

		continue
	}

	rows.push({ ...rowToParquet(aligned.row), locale: null, augmentation: null })
}

const coordinates = new Map(places.map((place) => [place.qid, place.coordinate]))

await writeParquetFile(rows, out(`${VITAL_PLACES_SOURCE}-00000.parquet`), {
	extractHash: `${VITAL_PLACES_SOURCE}:${sha256Hex(stringifyJSON(places))}`,
	codeHash: "packages/corpus/lib/tools/vital-places.run.ts",
	config: { sourceDir: sourceDir.toString(), exempt: exempt.size },
})

// The holdout rows take the famous-places fixture's shape, so its scorer grades them.
await writeLocalJSONLFile(
	render.holdout.map((row) => ({
		qid: row.qid,
		kind: "holdout",
		country: row.country,
		lat: coordinates.get(row.qid)?.lat,
		lon: coordinates.get(row.qid)?.lon,
		tolerance_m: 50_000,
		form: "country" in row.components ? "with-country" : "bare",
		input: row.raw,
		components: row.components,
	})),
	out(`${VITAL_PLACES_SOURCE}-holdout.jsonl`)
)

const counts = { ...render.counts, rows: rows.length, holdoutRows: render.holdout.length, quarantined: quarantined.length }

await writeLocalJSONFile(counts, out(`${VITAL_PLACES_SOURCE}-counts.json`))

console.log(stringifyJSON(counts))
