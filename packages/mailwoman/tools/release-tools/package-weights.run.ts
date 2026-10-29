/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes `neural-weights-<locale>/` package directories from an int8 model, its tokenizer and a checkpoint's
 *   `config.json`.
 *
 *   The card's eval section is the report `--eval-report` names, as JSON. Without one the card records that no golden
 *   set was evaluated. The checkpoint's `num_address_systems` decides whether the card holds the `address_systems`
 *   table, read from the committed address-system registry.
 *
 *   Usage: `node packages/mailwoman/tools/release-tools/package-weights.run.ts --checkpoint <dir> --int8-model
 *   <model.onnx> --tokenizer <tokenizer.model> [--packages-root <dir>] [--locales en-us,fr-fr] [--corpus-version 0.1.0]
 *   [--tokenizer-version 0.1.0] [--package-version 0.1.0] [--steps 0] [--hardware ""]
 *   [--training-duration-seconds 0] [--notes ""] [--eval-report <report.json>] [--completed-at <ISO time>] [--smoke]`
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { readAddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { join } from "path-ts"

import {
	ACTIVE_BIO_LABELS,
	buildModelCard,
	noEvalReport,
	parseEvalReport,
	renderPackageJSON,
	renderReadme,
	writeWeightsPackage,
} from "#tools/release-tools/package-weights"

const SCOPE = "package-weights"

const { values } = parseArguments({
	options: {
		checkpoint: { type: "string" },
		"int8-model": { type: "string" },
		tokenizer: { type: "string" },
		"packages-root": { type: "string" },
		locales: { type: "string", default: "en-us,fr-fr" },
		"corpus-version": { type: "string", default: "0.1.0" },
		"tokenizer-version": { type: "string", default: "0.1.0" },
		"package-version": { type: "string", default: "0.1.0" },
		steps: { type: "string", default: "0" },
		hardware: { type: "string", default: "" },
		"training-duration-seconds": { type: "string", default: "0" },
		notes: { type: "string", default: "" },
		"eval-report": { type: "string" },
		"completed-at": { type: "string" },
		smoke: { type: "boolean", default: false },
	},
})

const checkpoint = requiredArgument(SCOPE, "checkpoint", values.checkpoint)
const int8ModelPath = requiredArgument(SCOPE, "int8-model", values["int8-model"])
const tokenizerModelPath = requiredArgument(SCOPE, "tokenizer", values.tokenizer)
const steps = Number(values.steps)
const duration = Number(values["training-duration-seconds"])

if (!Number.isInteger(steps)) throw new Error(`--steps ${values.steps} is not an integer`)

if (!Number.isFinite(duration)) throw new Error(`--training-duration-seconds ${values["training-duration-seconds"]}`)

const config = await readLocalJSONFile<{ num_labels?: number; num_address_systems?: number }>(
	join(checkpoint, "config.json")
)

// The card writes the active set's labels, so a head of another width would ship a label map it does not emit.
if (config.num_labels !== ACTIVE_BIO_LABELS.length) {
	throw new Error(
		`${checkpoint}/config.json has num_labels ${config.num_labels}; the card writes ${ACTIVE_BIO_LABELS.length} labels`
	)
}

const addressSystemCount = config.num_address_systems ?? 0

const evalReport = values["eval-report"]
	? parseEvalReport(await readLocalTextFile(values["eval-report"]))
	: noEvalReport()

const completedAt = values["completed-at"] ? new Date(values["completed-at"]) : new Date()

if (Number.isNaN(completedAt.getTime())) throw new Error(`--completed-at ${values["completed-at"]} is not a time`)

const addressSystems = addressSystemCount ? await readAddressSystemRegistry() : null
const packagesRoot = values["packages-root"] ?? repoRootPath("packages").toString()
const packageVersion = values["package-version"]

const locales = values.locales
	.split(",")
	.map((locale) => locale.trim())
	.filter(isPresent)

for (const locale of locales) {
	const directory = join(packagesRoot, `neural-weights-${locale}`)

	await writeWeightsPackage(directory, {
		int8ModelPath,
		tokenizerModelPath,
		modelCard: buildModelCard({
			locale,
			corpusVersion: values["corpus-version"],
			tokenizerVersion: values["tokenizer-version"],
			trainingSteps: steps,
			evalReport,
			notes: values.notes,
			trainingHardware: values.hardware,
			trainingDurationSeconds: duration,
			basePath: checkpoint,
			packageVersion,
			addressSystemCount,
			addressSystems,
			completedAt,
		}),
		packageJSON: renderPackageJSON(locale, packageVersion),
		readme: renderReadme({
			locale,
			corpusVersion: values["corpus-version"],
			evalReport,
			trainingSteps: steps,
			trainingHardware: values.hardware,
			smoke: values.smoke,
		}),
	})

	console.log(`wrote weights package → ${directory}`)
}
