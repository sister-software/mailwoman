/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fits `crf-transitions.json` from a training config's rows: label bigrams over the pieces the trainer's row encoder
 *   labels, with add-one smoothing, centered so each row's most frequent successor scores 0.
 *
 *   Usage:
 *   node packages/mailwoman/tools/training/fit-transitions.run.ts --config <yaml> --model-card <model-card.json> \
 *     --out <crf-transitions.json> [--rows 200000] [--temperature 1] [--seed 42]
 *
 *   The label order is the model card's, and the fit refuses a card whose labels differ from the encoder's label schema.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"

import { applyOverrides, loadTrainingConfig, rerootToHost } from "./config.ts"
import { countBatchTransitions, emptyTransitionCounts, fitTransitions, scaleTransitions } from "./fit-transitions.ts"
import { createConfigRowEncoder, LABEL_SCHEMA_PATH, openSampler, sampledBatches } from "./sampler.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string", description: "The training config YAML" },
		"model-card": { type: "string", description: "The model card whose label order the potentials follow" },
		out: { type: "string", description: "The crf-transitions.json to write" },
		rows: { type: "string", default: "200000", description: "The training rows to count" },
		temperature: { type: "string", default: "1", description: "The factor every potential is multiplied by" },
		seed: { type: "string", default: "42", description: "The sampler seed" },
		set: { type: "string", multiple: true, default: [], description: "A config override, key=value" },
	},
})

if (!values.config || !values["model-card"] || !values.out) {
	throw new Error("--config, --model-card and --out are required")
}

interface LabelSchema {
	ignore_index: number
	default_label_set: string
	label_sets: Record<string, { bio_labels: string[] }>
}

const card = await readLocalJSONFile<{ labels: string[] }>(values["model-card"])
const schema = await readLocalJSONFile<LabelSchema>(LABEL_SCHEMA_PATH)
const schemaLabels = schema.label_sets[schema.default_label_set]?.bio_labels

if (!schemaLabels || schemaLabels.join("\n") !== card.labels.join("\n")) {
	throw new Error(`${values["model-card"]}: its labels differ from ${LABEL_SCHEMA_PATH}'s ${schema.default_label_set}`)
}

const rows = Number(values.rows)
const config = rerootToHost(applyOverrides(await loadTrainingConfig(values.config), values.set))
const mtf = await mtfNode()
const encoder = createConfigRowEncoder(mtf, config.data)
const sampler = openSampler(mtf, config, "train", Number(values.seed), { rowLimit: rows })
const counts = emptyTransitionCounts(card.labels)

for (const batch of sampledBatches(sampler, 256)) {
	const encoded = encoder.encodeBatch(batch)

	countBatchTransitions(counts, encoded.labels, encoded.rows, encoded.maxLength, schema.ignore_index)
}

if (counts.rows === 0) throw new Error(`${values.config}: the train split gave no labeled row`)

const fitted = scaleTransitions(fitTransitions(counts), Number(values.temperature))

await writeLocalJSONFile({ ...fitted, config: values.config, temperature: Number(values.temperature) }, values.out)

console.log(`[fit-transitions] ${counts.rows} rows counted -> ${values.out}`)
