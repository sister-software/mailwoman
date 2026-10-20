/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares two held-out dataset versions: added and removed countries, changed sources, and changed row
 *   counts per country and kind.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/compare.run.ts \
 *     --from <dataset manifest .json> --to <dataset manifest .json> [--out <comparison .json>]
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { compareHeldoutDatasets, readHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"

const { values } = parseArguments({
	options: {
		from: { type: "string", description: "The earlier dataset manifest" },
		to: { type: "string", description: "The later dataset manifest" },
		out: { type: "string", description: "Where to write the comparison JSON" },
	},
})

if (!values.from || !values.to) throw new Error("--from and --to are required")

const comparison = compareHeldoutDatasets(
	await readHeldoutDatasetManifest(values.from),
	await readHeldoutDatasetManifest(values.to)
)

if (values.out) {
	await writeLocalJSONFile(comparison, values.out)
}

const list = (items: readonly string[]) => (items.length ? items.join(", ") : "none")

console.log(
	`${comparison.from.datasetID}@${comparison.from.version} -> ${comparison.to.datasetID}@${comparison.to.version}`
)
console.log(
	`drawn-from corpus changed: ${comparison.drawnFromChanged}; sampling rule changed: ${comparison.samplingChanged}`
)
console.log(`countries added: ${list(comparison.countries.added)}`)
console.log(`countries removed: ${list(comparison.countries.removed)}`)
console.log(`sources added: ${list(comparison.sources.added)}`)
console.log(`sources removed: ${list(comparison.sources.removed)}`)

for (const change of comparison.sources.changed) {
	console.log(`source ${change.source}: ${change.from} -> ${change.to} rows`)
}

for (const change of comparison.cells) {
	console.log(`cell ${change.cell}: ${change.from} -> ${change.to} rows`)
}

console.log(
	`rows added ${comparison.rows.added}, removed ${comparison.rows.removed}, ` +
		`annotation changed ${comparison.rows.annotationChanged.length}, group changed ${comparison.rows.groupChanged.length}`
)
