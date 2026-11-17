// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the evaluation-group list a split under the evaluation-group policy keeps out of train
 *   (HOLDOUT_AND_EVALUATION section 4.6): every group the frozen sets in `--datasets` drew from.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/evaluation-groups.run.ts \
 *     --datasets /mnt/mw/corpus/heldout/heldout-dev-v0.8.18.v2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.18.v2.json,\
 *   /mnt/mw/corpus/heldout/heldout-dev-v0.8.19-probes-r2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.19-probes-r2.json \
 *     --out packages/corpus/data/holdout/evaluation-groups.v0.8.19.json
 *
 *   Each manifest is read with `readHeldoutDatasetManifest`, and each entry's
 *   `group` is the value the freeze wrote.
 *   Each set records what it was drawn from, a corpus manifest or a probe render's lineage.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { buildEvaluationGroupsFile } from "@mailwoman/corpus/utils/evaluation-groups"

import { readHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"

const { values } = parseArguments({
	options: {
		datasets: { type: "string", description: "Frozen dataset manifests, comma-separated" },
		out: { type: "string", description: "Where to write the evaluation-group list" },
	},
})

if (!values.datasets || !values.out) throw new Error("--datasets and --out are required")

const paths = values.datasets
	.split(",")
	.map((path) => path.trim())
	.filter((path) => path.length > 0)

const manifests = await Promise.all(
	paths.map(async (path) => ({ path, manifest: await readHeldoutDatasetManifest(path) }))
)

const file = buildEvaluationGroupsFile({
	datasets: await Promise.all(
		manifests.map(async ({ path, manifest }) => ({
			datasetID: manifest.datasetID,
			version: manifest.version,
			drawnFrom: { corpusVersion: manifest.drawnFrom.corpusVersion, sha256: manifest.drawnFrom.sha256 },
			manifestSHA256: await sha256File(path),
			rows: manifest.rows.length,
			groups: manifest.rows.map((row) => row.group),
		}))
	),
})

await writeLocalJSONFile(file, values.out)

console.log(
	`${values.out}: ${file.groups.length} groups from ` +
		file.datasets.map((set) => `${set.datasetID}@${set.version} (${set.rows} rows, ${set.groups} groups)`).join(", ")
)
