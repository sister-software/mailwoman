/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts one corpus version's rows by split, country, locale, source and recorded surface origin, and
 *   its spans by country and component tag.
 *
 *   This answers the planet-scale question the coverage register cannot: which countries contribute
 *   training, validation and test rows to the decoder being trained, and through which source and written
 *   surface. `censusCoverage` in `mailwoman/coverage` reads the train split alone and reports rows and
 *   street rows per country, so it cannot separate a source from a surface or a component from a row.
 *
 *   Three outputs stay separate because they count different things. A row-level count answers how many
 *   rows a stratum holds. A component-level count answers how many spans carry a tag, and those overlap
 *   within a row, so the two never sum to each other. A file-level record answers which inputs the pass
 *   actually read.
 *
 *   The recorded `surface` is reported exactly as the corpus stores it. Three adapters declared
 *   `attested` while rendering the line until `d397d140a`, so a row in a corpus built before that commit
 *   carries a label its adapter would no longer write. This tool preserves the stored value and leaves
 *   that interpretation to its reader, because rewriting an immutable corpus version's label inside a
 *   census would make the census disagree with the artifact it describes.
 *
 *   A file the reader cannot open is recorded by path under `unreadableFiles`, and `rowsRead` against the
 *   manifest's own `counts` states whether the pass covered the whole corpus. A partial read reports as
 *   partial rather than as a smaller corpus.
 *
 *   The pass groups in DuckDB rather than streaming rows through this process, because the answer is a
 *   cross-tab of counts and this corpus version holds 697,653,209 train rows. It writes its artifact after
 *   every file, so a killed run keeps the files it finished and `--resume` continues from them.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/global-census.run.ts \
 *     --manifest /mnt/mw/corpus/versioned/v0.7.0-de-holdout/corpus-v0.7.0-de-holdout/MANIFEST.json \
 *     --out /mnt/mw/audits/global-census-v0.7.0-de-holdout.json [--resume] [--split train,val,test]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools"

import { readAdmittedCountries } from "#tools/coverage/census"

const { values } = parseArguments({
	options: {
		manifest: { type: "string", description: "The corpus MANIFEST.json to census" },
		out: { type: "string", description: "Where to write the census artifact" },
		resume: { type: "boolean", description: "Keep the files an earlier run of this artifact finished" },
		split: { type: "string", description: "Comma-separated splits to read (default: train,val,test)" },
		config: {
			type: "string",
			description: "Training config whose `country_weights` decides admission, for the deficit list",
		},
	},
})

if (!values.manifest) throw new Error("--manifest is required, so the census names the corpus it read")

if (!values.out) throw new Error("--out is required, so a client timeout cannot discard the result")

// A superseded corpus directory holds a complete parquet set, so a census pointed
// at one reports a real corpus that no run trained on.
// The earlier naming defect left one beside the intended directory.
if (values.manifest.includes(".superseded")) {
	throw new Error(
		`${values.manifest} sits under a superseded corpus directory. Name the intended corpus directory instead, ` +
			`because a census of a superseded set describes rows no training run reads.`
	)
}

const wantedSplits = new Set(
	(values.split ?? "train,val,test")
		.split(",")
		.map((split) => split.trim())
		.filter((split) => split.length > 0)
)

interface ManifestShape {
	corpus_version?: string
	counts?: Record<string, number>
	total_rows?: number
	slices?: unknown
}

const manifest = await readLocalJSONFile<ManifestShape>(values.manifest)

/**
 * One row-level stratum: every dimension the corpus records per row.
 */
interface RowStratum {
	split: string
	country: string
	locale: string | null
	source: string
	surface: string | null
	rows: number
}

/**
 * One component-level stratum.
 *
 * These counts overlap within a row, so they never sum to {@link RowStratum}.
 */
interface ComponentStratum {
	split: string
	country: string
	tag: string
	spans: number
}

/**
 * Where a country's contribution stops, read from the census against the config's admitted set.
 *
 * `country_weights` is a hard filter, so a country the config omits trains on
 * no row whatever the corpus holds.
 * A country the config admits and the corpus holds no row for stops earlier, at the corpus.
 *
 * The two lists separate an ingest gap from a configuration gap, and a single
 * count of trained countries states neither.
 */
interface Deficits {
	config: string
	admitted: number
	trainedCountries: number
	admittedWithNoTrainRows: string[]
	trainedButNotAdmitted: string[]
	trainedWithNoValidationRows: string[]
	trainedWithNoTestRows: string[]
	trainedStreetWithNoValidationStreet: string[]
	trainedWithNoStreetSpans: string[]
}

interface Census {
	takenAt: string
	manifest: string
	corpusVersion: string
	manifestCounts: Record<string, number>
	manifestTotalRows: number
	filesListed: number
	filesRead: number
	rowsRead: number
	unreadableFiles: Array<{ path: string; error: string }>
	finishedFiles: string[]
	rowStrata: RowStratum[]
	componentStrata: ComponentStratum[]
	/**
	 * Absent when no `--config` was named, which is a census without an admission reading
	 * rather than a census reporting no deficit.
	 */
	deficits?: Deficits
}

/**
 * Derives the deficit lists from the accumulated strata and one config's admitted set.
 */
function readDeficits(
	configPath: string,
	admitted: ReadonlySet<string>,
	rows: ReadonlyMap<string, RowStratum>,
	components: ReadonlyMap<string, ComponentStratum>
): Deficits {
	const countriesIn = (split: string): Set<string> =>
		new Set(
			[...rows.values()]
				.filter((stratum) => stratum.split === split && stratum.rows > 0 && stratum.country !== "ZZ")
				.map((stratum) => stratum.country)
		)

	const streetIn = (split: string): Set<string> =>
		new Set(
			[...components.values()]
				.filter((stratum) => stratum.split === split && stratum.tag === "street" && stratum.spans > 0)
				.map((stratum) => stratum.country)
		)

	const trained = countriesIn("train")
	const trainStreet = streetIn("train")
	const valStreet = streetIn("val")

	const missing = (from: ReadonlySet<string>, against: ReadonlySet<string>): string[] =>
		[...from].filter((country) => !against.has(country)).toSorted()

	return {
		config: configPath,
		admitted: admitted.size,
		trainedCountries: trained.size,
		admittedWithNoTrainRows: missing(admitted, trained),
		trainedButNotAdmitted: missing(trained, admitted),
		trainedWithNoValidationRows: missing(trained, countriesIn("val")),
		trainedWithNoTestRows: missing(trained, countriesIn("test")),
		trainedStreetWithNoValidationStreet: missing(trainStreet, valStreet),
		trainedWithNoStreetSpans: missing(trained, trainStreet),
	}
}

const files = baseManifestFiles(manifest as { slices?: unknown })
	.filter((file) => wantedSplits.has(String(file.split)) && file.path)
	.map((file) => ({ split: String(file.split), path: localManifestFilePath(file.path) }))

const prior = values.resume ? await readLocalJSONFile<Census>(values.out).catch(() => null) : null
const finished = new Set<string>(prior?.finishedFiles)

/**
 * Accumulates a stratum count under a composite key, so a second file's rows add to the first file's.
 */
const rowCounts = new Map<string, RowStratum>()
const componentCounts = new Map<string, ComponentStratum>()

for (const stratum of prior?.rowStrata ?? []) {
	rowCounts.set([stratum.split, stratum.country, stratum.locale, stratum.source, stratum.surface].join("\u0000"), {
		...stratum,
	})
}

for (const stratum of prior?.componentStrata ?? []) {
	componentCounts.set([stratum.split, stratum.country, stratum.tag].join("\u0000"), { ...stratum })
}

const census: Census = {
	takenAt: new Date().toISOString(),
	manifest: values.manifest,
	corpusVersion: manifest.corpus_version ?? "(unstated)",
	manifestCounts: manifest.counts ?? {},
	manifestTotalRows: manifest.total_rows ?? 0,
	filesListed: files.length,
	filesRead: prior?.filesRead ?? 0,
	rowsRead: prior?.rowsRead ?? 0,
	unreadableFiles: prior?.unreadableFiles ?? [],
	finishedFiles: [...finished],
	rowStrata: [],
	componentStrata: [],
}

/**
 * Writes the artifact from the accumulators, so a killed run keeps every file it finished.
 */
async function persist(): Promise<void> {
	census.rowStrata = [...rowCounts.values()].toSorted((a, b) => b.rows - a.rows)
	census.componentStrata = [...componentCounts.values()].toSorted((a, b) => b.spans - a.spans)
	census.finishedFiles = [...finished]

	if (admittedCountries) {
		census.deficits = readDeficits(values.config!, admittedCountries, rowCounts, componentCounts)
	}

	await writeLocalJSONFile(census, values.out!)
}

const admittedCountries = values.config ? await readAdmittedCountries(values.config) : null

using db = await openDuckDB()

console.log(`census of ${census.corpusVersion}`)
console.log(`  manifest: ${values.manifest}`)
console.log(`  manifest counts: ${stringifyJSON(census.manifestCounts)}`)
console.log(`  files listed for ${[...wantedSplits].join(", ")}: ${files.length}`)
console.log(`  already finished: ${finished.size}`)
console.log(`  writing: ${values.out}\n`)

let index = 0

for (const file of files) {
	index++

	if (finished.has(file.path)) continue

	const literal = escapeSQLString(file.path)

	try {
		const rows = (
			await db.runAndReadAll(
				`SELECT country, locale, source, surface, count(*) AS n
				 FROM read_parquet('${literal}')
				 GROUP BY 1, 2, 3, 4`
			)
		).getRowObjectsJS() as Array<{
			country: string | null
			locale: string | null
			source: string | null
			surface: string | null
			n: bigint | number
		}>

		let fileRows = 0

		for (const row of rows) {
			// A row whose country the corpus left empty reads `??` rather than joining a real country.
			const country = (row.country ?? "").toUpperCase() || "??"
			const source = row.source ?? "(unstated)"
			const key = [file.split, country, row.locale, source, row.surface].join("\u0000")
			const held = rowCounts.get(key)
			const n = Number(row.n)

			fileRows += n

			if (held) {
				held.rows += n
			} else {
				rowCounts.set(key, {
					split: file.split,
					country,
					locale: row.locale ?? null,
					source,
					surface: row.surface ?? null,
					rows: n,
				})
			}
		}

		const components = (
			await db.runAndReadAll(
				`SELECT country, tag, count(*) AS n
				 FROM (SELECT country, unnest(span_tags) AS tag FROM read_parquet('${literal}'))
				 GROUP BY 1, 2`
			)
		).getRowObjectsJS() as Array<{ country: string | null; tag: string | null; n: bigint | number }>

		for (const row of components) {
			const country = (row.country ?? "").toUpperCase() || "??"
			const tag = row.tag ?? "(unstated)"
			const key = [file.split, country, tag].join("\u0000")
			const held = componentCounts.get(key)
			const n = Number(row.n)

			if (held) {
				held.spans += n
			} else {
				componentCounts.set(key, { split: file.split, country, tag, spans: n })
			}
		}

		census.filesRead++
		census.rowsRead += fileRows
		finished.add(file.path)
	} catch (error) {
		census.unreadableFiles.push({ path: file.path, error: (error as Error).message })
	}

	await persist()

	if (index % 10 === 0 || index === files.length) {
		console.log(
			`  ${index} of ${files.length} listed  read ${census.filesRead}  rows ${census.rowsRead.toLocaleString()}` +
				(census.unreadableFiles.length ? `  unreadable ${census.unreadableFiles.length}` : "")
		)
	}
}

await persist()

const expected = [...wantedSplits].reduce((sum, split) => sum + (census.manifestCounts[split] ?? 0), 0)

console.log(`\nfiles read: ${census.filesRead} of ${census.filesListed}`)
console.log(`rows read: ${census.rowsRead.toLocaleString()}`)
console.log(`manifest counts for those splits: ${expected.toLocaleString()}`)
console.log(
	census.rowsRead === expected
		? `reconciled: the pass read every row the manifest counts`
		: `PARTIAL: the pass read ${(expected - census.rowsRead).toLocaleString()} fewer rows than the manifest counts`
)

if (census.unreadableFiles.length) {
	console.log(`\nunreadable files: ${census.unreadableFiles.length}`)

	for (const entry of census.unreadableFiles.slice(0, 10)) {
		console.log(`  ${entry.path}\n    ${entry.error}`)
	}
}

console.log(`\nrow strata: ${census.rowStrata.length}   component strata: ${census.componentStrata.length}`)

const deficits = census.deficits

if (deficits) {
	console.log(`\ndeficits against ${deficits.config}`)
	console.log(`  countries admitted by country_weights: ${deficits.admitted}`)
	console.log(`  countries holding train rows: ${deficits.trainedCountries}`)
	console.log(`  admitted with no train row: ${deficits.admittedWithNoTrainRows.length}`)
	console.log(`  holding train rows and not admitted: ${deficits.trainedButNotAdmitted.join(", ") || "(none)"}`)
	console.log(`  trained with no validation row: ${deficits.trainedWithNoValidationRows.length}`)
	console.log(`  trained with no test row: ${deficits.trainedWithNoTestRows.length}`)
	console.log(`  trained street with no validation street span: ${deficits.trainedStreetWithNoValidationStreet.length}`)
	console.log(`  trained with no street span: ${deficits.trainedWithNoStreetSpans.join(", ") || "(none)"}`)
}

console.log(`\nwrote ${values.out}`)
