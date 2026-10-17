/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write the frozen source record of an overlay corpus by reading its parquet files.
 *
 *   `buildCorpus` writes `TRAINING_SOURCES.json` from the rows it aligned. An overlay corpus is assembled afterwards
 *   from that base plus parquet files a recipe or adapter run produced, and the assembly reads no row, so the
 *   overlay corpus has no record of its own. Without one, `effective-manifest.run.ts` can give a license only to the
 *   base build's sources and every overlay source stays unrecorded.
 *
 *   The base record cannot be composed with the added files, because it counts the adapter rows the build
 *   aligned and the build's files also hold the rows it synthesized from them. Measured over
 *   `v0.7.0-de-holdout`: the record counts 118,938,779 rows and the build's own `part-NNNN.parquet` files hold
 *   692,848,471. This reads every file the overlay manifest lists and groups the rows by their `source` and
 *   `license` columns. The trainer's loader reads those two columns. The record therefore states what the
 *   corpus holds rather than what one stage of its assembly observed.
 *
 *   The profile and the refused set are the base record's, because an overlay file enters by a recipe or an
 *   adapter run that applies no eligibility reading of its own. The license decisions are read from the register
 *   as it stands when this runs, and `builtAt` is when the overlay was applied.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/freeze-overlay-manifest.run.ts \
 *     --manifest <overlay corpus directory>/MANIFEST.json \
 *     --base-training-manifest <base build>/TRAINING_SOURCES.json \
 *     --out packages/corpus/data/training-manifests/<corpus version>.json
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { readRegisterDecisions } from "@mailwoman/corpus/build/eligibility"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { freezeTrainingManifest, NO_LICENSE_RECORDED, type TrainingManifest } from "@mailwoman/corpus/source-register"
import { localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { dirname, resolvePath } from "path-ts"

const { values } = parseArguments({
	options: {
		manifest: { type: "string", description: "The overlay corpus's inner MANIFEST.json" },
		"base-training-manifest": {
			type: "string",
			description: "The base build's TRAINING_SOURCES.json, for its profile and refused set",
		},
		out: { type: "string", description: "Where to write the frozen record" },
		"corpus-version": {
			type: "string",
			description: "The version to record. Defaults to the manifest's corpus_version with a `v` prefix",
		},
	},
})

if (!values.manifest) throw new Error("--manifest is required")

if (!values["base-training-manifest"]) throw new Error("--base-training-manifest is required")

if (!values.out) throw new Error("--out is required")

interface OverlayManifest {
	corpus_version: string
	slices: Array<{ path: string; rows: number; source?: string }>
}

interface OverlayPlan {
	appliedAt?: string
}

const manifest = await readLocalJSONFile<OverlayManifest>(values.manifest)
const base = await readLocalJSONFile<TrainingManifest>(values["base-training-manifest"])
const corpusVersion = values["corpus-version"] ?? `v${manifest.corpus_version}`

const planPath = resolvePath(dirname(values.manifest), "OVERLAY_PLAN.json")
const plan = (await pathExists(planPath)) ? await readLocalJSONFile<OverlayPlan>(planPath) : null

if (!plan?.appliedAt) {
	throw new Error(`${planPath} records no appliedAt, so when this corpus came to exist is unknown`)
}

const files = manifest.slices.map((file) => localManifestFilePath(file.path))
const listed = manifest.slices.reduce((total, file) => total + file.rows, 0)

for (const file of files) {
	if (!(await pathExists(file))) throw new Error(`${file} is listed by the manifest and absent from the data root`)
}

console.log(`${corpusVersion}: reading ${files.length} files, ${listed.toLocaleString()} rows listed`)

const labelsBySource = new Map<string, Map<string, number>>()
let counted = 0

{
	using db = await openDuckDB({ threads: 8 })

	const list = files.map((path) => `'${escapeSQLString(path)}'`).join(", ")

	const result = await db.runAndReadAll(
		`SELECT source, license, count(*) AS rows FROM read_parquet([${list}]) GROUP BY source, license ORDER BY source, license`
	)

	for (const row of result.getRows()) {
		const [source, license, rows] = row as [unknown, unknown, unknown]
		const count = Number(rows)

		counted += count

		if (typeof source !== "string" || !source) {
			throw new Error(`${count.toLocaleString()} rows carry no source, so no record can attribute them`)
		}

		// A row with an empty label is recorded under the label that says so,
		// because an empty string would read as a source carrying no terms.
		const label = typeof license === "string" && license ? license : NO_LICENSE_RECORDED
		const labels = labelsBySource.get(source) ?? new Map<string, number>()

		labels.set(label, (labels.get(label) ?? 0) + count)
		labelsBySource.set(source, labels)
	}
}

if (counted !== listed) {
	throw new Error(`the files hold ${counted.toLocaleString()} rows and the manifest lists ${listed.toLocaleString()}`)
}

// A source whose rows carry several labels records the majority label as its license and keeps
// every label with its rows, so the record states the whole set rather than one row's reading.
const rowsBySource = new Map(
	[...labelsBySource].map(([source, labels]) => {
		const ordered = [...labels].toSorted(([a, left], [b, right]) => right - left || a.localeCompare(b))
		const rows = ordered.reduce((total, [, count]) => total + count, 0)

		return [
			source,
			{
				rows,
				license: ordered[0]![0],
				...(ordered.length > 1 ? { licenseValues: Object.fromEntries(ordered) } : {}),
			},
		]
	})
)

const frozen = freezeTrainingManifest({
	corpusVersion,
	builtAt: plan.appliedAt,
	profile: base.profile,
	rowsBySource,
	decisionsByLicense: await readRegisterDecisions(),
	refused: new Map(Object.entries(base.refused)),
})

await writeLocalJSONFile(frozen, values.out)

for (const record of frozen.sources) {
	console.log(`  ${record.source}: ${record.rows.toLocaleString()} rows under ${record.license}`)
}

console.log(
	`${corpusVersion}: ${frozen.sources.length} sources, ${frozen.totalRows.toLocaleString()} rows, written to ${values.out}`
)
