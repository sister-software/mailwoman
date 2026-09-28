/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write the effective training manifest. It records which of a corpus's sources one config's audited epoch reached
 *   and why each remaining source did not reach the trainer.
 *
 *   The corpus's own `TRAINING_SOURCES.json` records what the corpus holds. A run reads it through a
 *   config. `country_weights`, `source_weights`, a `0.0` weight and `augment_exclude_sources` each remove
 *   rows between the two. A model card quoting the corpus manifest attributes sources the checkpoint never
 *   saw. This report separates the records.
 *
 *   Run `audit_epoch_mixture` first; `coverage-funnel.run.ts` names the command and the path it looks in.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/effective-manifest.run.ts \
 *     --corpus-manifest <corpus>/TRAINING_SOURCES.json \
 *     --config corpus-python/src/mailwoman_train/configs/<name>.yaml \
 *     [--mixture-audit <path>] [--out <path>] [--declared a,b,c]
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { extractDelimited, parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	deriveEffectiveTrainingManifest,
	epochMixtureAuditPath,
	provenanceDisagreement,
	readConfigView,
	type EpochMixtureAudit,
	type TrainingManifest,
} from "@mailwoman/corpus/source-register"
import { dirname, resolvePath } from "path-ts"

const { values } = parseArguments({
	options: {
		"corpus-manifest": { type: "string", description: "The corpus's frozen TRAINING_SOURCES.json" },
		config: { type: "string", description: "The training config the audit ran under" },
		"mixture-audit": { type: "string", description: "An audit_epoch_mixture --json output" },
		out: { type: "string", description: "Where to write the manifest. Defaults beside the corpus manifest" },
		declared: {
			type: "string",
			description: "Comma-separated sources a model card declares, compared against what the epoch reached",
		},
	},
})

if (!values["corpus-manifest"]) throw new Error("--corpus-manifest is required")

if (!values.config) throw new Error("--config is required")

const corpusManifest = await readLocalJSONFile<TrainingManifest>(values["corpus-manifest"])
const configPath = resolvePath(repoRootPath(), values.config)
const config = readConfigView(await readLocalTextFile(configPath))

const auditPath = values["mixture-audit"] ?? epochMixtureAuditPath(values.config).toString()

const audit = await readLocalJSONFile<EpochMixtureAudit>(auditPath)

const manifest = deriveEffectiveTrainingManifest({
	corpusManifest,
	audit,
	config,
	configPath: values.config,
})

const out = values.out ?? resolvePath(dirname(values["corpus-manifest"]), "TRAINING_SOURCES_EFFECTIVE.json")

await writeLocalJSONFile(manifest, out)

console.log(`corpus ${manifest.corpusVersion} through ${manifest.config}`)
console.log(`  audit ${auditPath}`)
console.log(
	`  seed ${manifest.seed}, ${manifest.drawsRealized.toLocaleString()} of ${manifest.drawsRequested.toLocaleString()} draws realized`
)
console.log(
	`  ${manifest.trainingSources.length} of ${manifest.sources.length} corpus sources reached the trainer, ` +
		`${manifest.totalEmittedRows.toLocaleString()} rows emitted`
)
console.log(
	`  ${manifest.countriesDrawingRows} of ${manifest.admittedCountries} admitted countries drew a row, ` +
		`${manifest.admittedCountriesDrawingZero.length} drew zero`
)

const unrecorded = Object.entries(manifest.emittedButUnrecorded)

if (unrecorded.length) {
	const rows = unrecorded.reduce((sum, [, count]) => sum + count, 0)
	const share = ((100 * rows) / manifest.totalEmittedRows).toFixed(1)

	console.log(
		`  ${unrecorded.length} emitted source(s) carry no entry in the corpus's frozen manifest, ` +
			`${rows.toLocaleString()} rows (${share}% of those emitted). They reached the corpus through an overlay ` +
			`merged after that manifest was written, so this record covers part of what trained the model.`
	)
}

console.log(`\n  source | corpus rows | weight | drawn | emitted | excluded because`)

for (const record of manifest.sources) {
	console.log(
		`  ${record.source} | ${record.corpusRows.toLocaleString()} | ${record.weight ?? "unweighted"} | ` +
			`${record.drawnRows.toLocaleString()} | ${record.emittedRows.toLocaleString()} | ` +
			`${record.excludedBecause ?? "—"}`
	)
}

if (values.declared) {
	const { declaredButNotTrained, trainedButNotDeclared } = provenanceDisagreement(
		manifest,
		extractDelimited(values.declared)
	)

	console.log(`\n  declared and never trained on: ${declaredButNotTrained.join(", ") || "none"}`)
	console.log(`  trained on and never declared: ${trainedButNotDeclared.join(", ") || "none"}`)
}

console.log(`\nwrote ${out}`)
