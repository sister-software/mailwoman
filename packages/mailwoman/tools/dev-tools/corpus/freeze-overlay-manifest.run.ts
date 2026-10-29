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
 *   692,848,471. This tallies every file the overlay manifest lists by its rows' `source` and `license` columns,
 *   which the trainer's loader reads. A file with a `<stem>.RECORD.json` beside it contributes the tally its writer
 *   recorded. Only a file without one is re-read. The record therefore states what the corpus holds rather than
 *   what one stage of its assembly observed.
 *
 *   The profile and the refused set are the base record's, because an overlay file enters by a recipe or an
 *   adapter run that applies no eligibility reading of its own. Each source's license decisions are read from the
 *   register as it stands when this runs, through the register inputs `corpus-source-inputs.json` maps the source
 *   to, and `builtAt` is when the corpus overlay was applied.
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
import { readSourceDecisionTable } from "@mailwoman/corpus/build/eligibility"
import { foldSourceLicenses, rowsBySourceFromTally } from "@mailwoman/corpus/parquet/record"
import { freezeTrainingManifest, type TrainingManifest } from "@mailwoman/corpus/source-register"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
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
	files: Array<{ path: string; rows: number; sha256?: string; source?: string }>
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

const files = baseManifestFiles<(typeof manifest)["files"][number]>(manifest).map((file) =>
	localManifestFilePath(file.path)
)

const listed = baseManifestFiles<(typeof manifest)["files"][number]>(manifest).reduce(
	(total, file) => total + file.rows,
	0
)

for (const file of files) {
	if (!(await pathExists(file))) throw new Error(`${file} is listed by the manifest and absent from the data root`)
}

console.log(`${corpusVersion}: folding ${files.length} files, ${listed.toLocaleString()} rows listed`)

const { tally, folded, reread } = await foldSourceLicenses(
	baseManifestFiles<(typeof manifest)["files"][number]>(manifest).map((file, index) => ({
		path: files[index]!,
		rows: file.rows,
		sha256: file.sha256,
	}))
)

console.log(`${corpusVersion}: ${folded} files folded from their records, ${reread} re-read for want of one`)

const frozen = freezeTrainingManifest({
	corpusVersion,
	builtAt: plan.appliedAt,
	profile: base.profile,
	rowsBySource: rowsBySourceFromTally(tally),
	decisionTable: await readSourceDecisionTable(),
	refused: new Map(Object.entries(base.refused)),
})

await writeLocalJSONFile(frozen, values.out)

for (const record of frozen.sources) {
	console.log(`  ${record.source}: ${record.rows.toLocaleString()} rows under ${record.license}`)
}

console.log(
	`${corpusVersion}: ${frozen.sources.length} sources, ${frozen.totalRows.toLocaleString()} rows, written to ${values.out}`
)
