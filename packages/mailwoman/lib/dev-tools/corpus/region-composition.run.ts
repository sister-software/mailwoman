/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which US regions the training mixture writes, per source (#2311).
 *
 *   The bare admin surface reads 100.0% in Vermont and 2.3% in Arkansas over a region-stratified panel, and a swap test
 *   places the cause in the region code and the postcode rather than the locality name. This reads the corpus the
 *   candidate trained on and reports where each source's US rows sit, so the claim "the mixture is thin on Arkansas"
 *   is a count rather than a guess.
 *
 *   A row's region is the text its `region` span covers, folded to a USPS code with `lookupUSState`, because the corpus
 *   writes `California`, `california` and `CA` as separate surfaces of one region. A US row with no `region` span is
 *   counted separately: it carries no region at all, so it is neither present nor absent for any code.
 *
 *   The aggregation runs inside DuckDB and only the grouped counts cross into JS. The train split is 681,901,687 rows
 *   over 718 parquet files and 40 GB, which the grouped query reads in 45,519 ms at six threads.
 *
 *   This measures the POOL, not the exposure. A training run draws from each source under `source_weights` and
 *   `source_reps` in its config, so a source's region spread bounds what the run can see and does not state it. Read
 *   this table beside the config's weights.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/corpus/region-composition.run.ts
 *       node packages/mailwoman/lib/dev-tools/corpus/region-composition.run.ts --corpus <dir> --out-json <path>
 */

import { US_STATE_ABBREVIATIONS, lookupUSState } from "@mailwoman/codex/us/state"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"

import { openMixture, readMixtureFiles } from "#dev-tools/corpus/mixture"

const DEFAULT_CORPUS = String(
	dataRootPath("corpus", "versioned", "v0.31.0-region-code-and-unit", "corpus-v0.31.0-region-code-and-unit")
)

const { values } = parseArguments({
	options: {
		corpus: { type: "string", default: DEFAULT_CORPUS },
		split: { type: "string", default: "train" },
		"out-json": { type: "string" },
		/**
		 * Sources whose region spread is printed in full. The pooled table covers the rest.
		 */
		detail: { type: "string", default: "12" },
		"memory-limit": { type: "string", default: "8GB" },
		threads: { type: "string", default: "8" },
		/**
		 * Read only the first N parquet files of the split. A truncated run reports a share of one corner of the corpus, so
		 * the header names the count it read against the count the manifest holds.
		 */
		files: { type: "string" },
	},
})

const mixture = await readMixtureFiles(values.corpus!, values.split!, values.files ? Number(values.files) : undefined)

const { db, fileList } = await openMixture(mixture.files, {
	memoryLimit: values["memory-limit"]!,
	threads: Number(values.threads),
})

/**
 * `span_starts` and `span_ends` are character offsets into `raw`, and `span_tags` is the parallel tag list, so the
 * region surface is the substring the `region` entry covers. DuckDB's `list_position` is 1-based and answers NULL when
 * the row carries no region span.
 */
const sql = `
WITH us AS (
	SELECT source, raw, span_starts, span_ends, list_position(span_tags, 'region') AS i
	FROM read_parquet([${fileList}])
	WHERE country = 'US'
)
SELECT
	source,
	CASE WHEN i IS NULL THEN NULL ELSE substring(raw, span_starts[i] + 1, span_ends[i] - span_starts[i]) END AS region,
	count(*) AS n
FROM us
GROUP BY 1, 2`

const started = Date.now()
const reader = await db.runAndReadAll(sql)

console.log(
	`${mixture.manifest.corpus_version} ${values.split}: ${mixture.files.length} of ${mixture.available} file(s), ` +
		`${mixture.rows.toLocaleString()} rows, ${Date.now() - started} ms\n`
)

/**
 * Per source: rows by folded region code, rows whose region text folds to no US code, and rows with no region span.
 */
interface SourceComposition {
	source: string
	byRegion: Map<string, number>
	unfolded: Map<string, number>
	noRegionSpan: number
}

const bySource = new Map<string, SourceComposition>()

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
	} else {
		entry.unfolded.set(surface, (entry.unfolded.get(surface) ?? 0) + rows)
	}
}

db.closeSync()

function regionRows(entry: SourceComposition): number {
	return [...entry.byRegion.values()].reduce((sum, n) => sum + n, 0)
}

/**
 * The share of a source's region-bearing rows held by its largest five regions. A source that writes all 56 codes
 * evenly reads near 5/56; one that writes a corner of the country reads near 1.
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
		`${pooledTotal.toLocaleString()} region-bearing US rows\n`
)

console.log(`| region | rows | share |`)
console.log(`| --- | --: | --: |`)

const ranked = [...pooled].toSorted((a, b) => b[1] - a[1])
const detail = Number(values.detail)

for (const [code, n] of [...ranked.slice(0, detail), ...ranked.slice(-detail)]) {
	console.log(`| ${code} | ${n.toLocaleString()} | ${formatPercent(n, pooledTotal)} |`)
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
