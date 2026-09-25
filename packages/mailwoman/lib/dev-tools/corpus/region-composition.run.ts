/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Counts each corpus source's US rows by region, with `--corpus <dir>` and `--out-json <path>` as options.
 */

import { US_STATE_ABBREVIATIONS, lookupUSState } from "@mailwoman/codex/us/state"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { componentAtIndexSQL } from "@mailwoman/corpus/parquet/span-sql"

import { openMixture, readMixtureFiles } from "#dev-tools/corpus/mixture"

const DEFAULT_CORPUS = dataRootPath(
	"corpus",
	"versioned",
	"v0.31.0-region-code-and-unit",
	"corpus-v0.31.0-region-code-and-unit"
)

const { values } = parseArguments({
	options: {
		corpus: { type: "string", default: DEFAULT_CORPUS.toString() },
		split: { type: "string", default: "train" },
		"out-json": { type: "string" },
		/**
		 * Sets how many of the largest and of the smallest pooled regions the region table prints.
		 */
		detail: { type: "string", default: "12" },
		"memory-limit": { type: "string", default: "8GB" },
		threads: { type: "string", default: "8" },
		/**
		 * Limits the run to the first N parquet files of the split.
		 *
		 * The header prints the number of files read beside the number in the manifest.
		 */
		files: { type: "string" },
	},
})

const mixture = await readMixtureFiles(values.corpus!, values.split!, values.files ? Number(values.files) : undefined)

await using mix = await openMixture(mixture.files, {
	memoryLimit: values["memory-limit"]!,
	threads: Number(values.threads),
})

/**
 * Groups the US rows by source, region text and row shape inside DuckDB,
 * so only grouped counts reach JavaScript.
 *
 * The region text is the substring of `raw` that the `region` span covers.
 * `list_position` is 1-based and returns NULL when the row has no region span.
 *
 * The counts describe the pool that a run draws from.
 * A run weights sources by `source_weights` and `source_reps`, so read these counts beside the config.
 */
const sql = `
WITH us AS (
	SELECT
		source,
		raw,
		span_starts,
		span_ends,
		list_position(span_tags, 'region') AS i,
		list_contains(span_tags, 'street') AS has_street,
		span_tags[list_position(span_starts, list_min(span_starts))] AS first_tag,
		-- The surface the probe writes: a locality, a region and a postcode, and nothing else. Compared as a SET, so a
		-- row is bare whatever order it writes them in.
		list_sort(list_distinct(span_tags)) = ['locality', 'postcode', 'region'] AS bare_admin
	FROM read_parquet([${mix.fileList}])
	WHERE country = 'US'
)
SELECT
	source,
	${componentAtIndexSQL("i")} AS region,
	has_street,
	first_tag,
	bare_admin,
	count(*) AS n
FROM us
GROUP BY 1, 2, 3, 4, 5`

const started = Date.now()
const reader = await mix.db.runAndReadAll(sql)

console.log(
	`${mixture.manifest.corpus_version} ${values.split}: ${mixture.files.length} of ${mixture.available} file(s), ` +
		`${mixture.rows.toLocaleString()} rows, ${Date.now() - started} ms\n`
)

/**
 * Holds one source's row counts by region code.
 *
 * `lookupUSState` folds region text such as `California` and `CA` to one code.
 * `unfolded` counts region text that folds to no code.
 *
 * `noRegionSpan` counts rows without a region, which count toward no code.
 */
interface SourceComposition {
	source: string
	byRegion: Map<string, number>
	unfolded: Map<string, number>
	noRegionSpan: number
}

const bySource = new Map<string, SourceComposition>()

/**
 * Holds per-region row counts, street-span counts and the tag each row opens with.
 *
 * The opening tag matters because a bare admin query starts with the locality.
 * A region whose rows open with a street has trained the model to expect a street in that position.
 */
const streetShapes = new Map<
	string,
	{
		rows: number
		withStreet: number
		bareAdmin: number
		/**
		 * Counts rows that write the region as its two-letter code, and how many of those are bare admin rows.
		 *
		 * The model sees `Arkansas` and `AR` as different strings, so the code form gets its own count.
		 */
		codeForm: number
		codeFormBare: number
		openingTag: Map<string, number>
	}
>()

for (const row of reader.getRowObjects()) {
	const source = String(row.source)
	const rows = Number(row.n)
	const surface = row.region == null ? null : String(row.region)

	let entry = bySource.get(source)

	if (!entry) {
		entry = { source, byRegion: new Map(), unfolded: new Map(), noRegionSpan: 0 }
		bySource.set(source, entry)
	}

	if (surface === null) {
		entry.noRegionSpan += rows

		continue
	}

	const code = lookupUSState(surface)

	if (code) {
		entry.byRegion.set(code, (entry.byRegion.get(code) ?? 0) + rows)

		const shape = streetShapes.get(code) ?? {
			rows: 0,
			withStreet: 0,
			bareAdmin: 0,
			codeForm: 0,
			codeFormBare: 0,
			openingTag: new Map<string, number>(),
		}

		shape.rows += rows

		if (row.has_street) {
			shape.withStreet += rows
		}

		if (row.bare_admin) {
			shape.bareAdmin += rows
		}

		if (surface === code) {
			shape.codeForm += rows

			if (row.bare_admin) {
				shape.codeFormBare += rows
			}
		}

		const opening = row.first_tag == null ? "none" : String(row.first_tag)

		shape.openingTag.set(opening, (shape.openingTag.get(opening) ?? 0) + rows)
		streetShapes.set(code, shape)
	} else {
		entry.unfolded.set(surface, (entry.unfolded.get(surface) ?? 0) + rows)
	}
}

function regionRows(entry: SourceComposition): number {
	return [...entry.byRegion.values()].reduce((sum, n) => sum + n, 0)
}

/**
 * Returns the share of a source's region rows held by its five largest regions.
 *
 * An even spread over all 56 codes gives about 5/56.
 * A source concentrated in a few regions gives nearly 1.
 */
function topFiveShare(entry: SourceComposition): number {
	const counts = [...entry.byRegion.values()].toSorted((a, b) => b - a)
	const total = regionRows(entry)

	return total === 0 ? 0 : counts.slice(0, 5).reduce((sum, n) => sum + n, 0) / total
}

const sources = [...bySource.values()].toSorted((a, b) => regionRows(b) - regionRows(a))
const pooled = new Map<string, number>()

for (const entry of sources) {
	for (const [code, n] of entry.byRegion) {
		pooled.set(code, (pooled.get(code) ?? 0) + n)
	}
}

const pooledTotal = [...pooled.values()].reduce((sum, n) => sum + n, 0)

console.log(`| source | region rows | regions | top-5 share | no region span | unfolded |`)
console.log(`| --- | --: | --: | --: | --: | --: |`)

for (const entry of sources) {
	const unfolded = [...entry.unfolded.values()].reduce((sum, n) => sum + n, 0)

	console.log(
		`| ${entry.source} | ${regionRows(entry).toLocaleString()} | ${entry.byRegion.size}/${US_STATE_ABBREVIATIONS.length} ` +
			`| ${(topFiveShare(entry) * 100).toFixed(1)}% | ${entry.noRegionSpan.toLocaleString()} | ${unfolded.toLocaleString()} |`
	)
}

console.log(
	`\nPooled over every source — ${pooled.size}/${US_STATE_ABBREVIATIONS.length} regions, ` +
		`${pooledTotal.toLocaleString()} region-containing US rows\n`
)

console.log(`| region | rows | share | opens on a locality | bare admin | code-form rows | bare of code-form |`)
console.log(`| --- | --: | --: | --: | --: | --: | --: |`)

const ranked = [...pooled].toSorted((a, b) => b[1] - a[1])
const detail = Number(values.detail)

for (const [code, n] of [...ranked.slice(0, detail), ...ranked.slice(-detail)]) {
	const shape = streetShapes.get(code)

	console.log(
		`| ${code} | ${n.toLocaleString()} | ${formatPercent(n, pooledTotal)} ` +
			`| ${shape ? formatPercent(shape.openingTag.get("locality") ?? 0, shape.rows) : "—"} ` +
			`| ${shape ? shape.bareAdmin.toLocaleString() : "—"} ` +
			`| ${shape ? shape.codeForm.toLocaleString() : "—"} ` +
			`| ${shape?.codeForm ? formatPercent(shape.codeFormBare, shape.codeForm) : "—"} |`
	)
}

const absent = US_STATE_ABBREVIATIONS.filter((code) => !pooled.has(code))

console.log(`\nregions with no row at all: ${!absent.length ? "none" : absent.join(", ")}`)

if (values["out-json"]) {
	await writeLocalJSONFile(
		{
			corpus_version: mixture.manifest.corpus_version,
			split: values.split,
			files: mixture.files.length,
			pooled: Object.fromEntries(ranked),
			street_shapes: Object.fromEntries(
				[...streetShapes].map(([code, shape]) => [
					code,
					{
						rows: shape.rows,
						with_street: shape.withStreet,
						bare_admin: shape.bareAdmin,
						code_form: shape.codeForm,
						code_form_bare: shape.codeFormBare,
						opening_tag: Object.fromEntries([...shape.openingTag].toSorted((a, b) => b[1] - a[1])),
					},
				])
			),
			sources: sources.map((entry) => ({
				source: entry.source,
				no_region_span: entry.noRegionSpan,
				by_region: Object.fromEntries([...entry.byRegion].toSorted((a, b) => b[1] - a[1])),
				unfolded: Object.fromEntries([...entry.unfolded].toSorted((a, b) => b[1] - a[1]).slice(0, 20)),
			})),
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
