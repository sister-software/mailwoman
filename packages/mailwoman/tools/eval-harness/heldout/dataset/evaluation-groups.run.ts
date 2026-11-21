// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the evaluation-group list a split under the evaluation-group policy keeps
 *   out of train (HOLDOUT_AND_EVALUATION section 4.6): every group the frozen sets
 *   in `--datasets` drew from, and the address key of every frozen row whose source
 *   keys groups by address (`GROUP_ADDRESS_KEY_SOURCES`, #3125).
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/evaluation-groups.run.ts \
 *     --datasets /mnt/mw/corpus/heldout/heldout-dev-v0.8.18.v2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.18.v2.json,\
 *   /mnt/mw/corpus/heldout/heldout-dev-v0.8.19-probes-r2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.19-probes-r2.json \
 *     --out packages/corpus/data/holdout/evaluation-groups.v0.8.19.json
 *
 *   Each manifest is read with `readHeldoutDatasetRows`, and each entry's
 *   `group` is the value the freeze wrote.
 *   Each set records what it was drawn from, a corpus manifest or a probe render's lineage.
 *
 *   `--extend <evaluation-groups.json>` starts from a committed list and adds the sets in `--datasets`,
 *   so a new version keeps every group of the last one, including a set whose manifest isn't on disk.
 *   `--key-datasets` names manifests of sets the extended list already holds whose
 *   rows' address keys it lacks, such as a list written before #3125.
 *   Each must be the version the list names.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	buildEvaluationGroupsFile,
	EVALUATION_GROUPS_ATTRIBUTE,
	type EvaluationGroupsFile,
} from "@mailwoman/corpus/utils/evaluation-groups"

import { readHeldoutDatasetRows } from "#tools/eval-harness/heldout/dataset/manifest"

const { values } = parseArguments({
	options: {
		datasets: { type: "string", description: "Frozen dataset manifests, comma-separated" },
		out: { type: "string", description: "Where to write the evaluation-group list" },
		extend: { type: "string", description: "A committed evaluation-group list to add the sets to" },
		"key-datasets": {
			type: "string",
			description: "Manifests of sets the --extend list holds, whose rows' address keys are added, comma-separated",
		},
	},
})

if (!values.out) throw new Error("--out is required")

if (!values.datasets && !values.extend) throw new Error("--datasets or --extend is required")

const listed = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((path) => path.trim())
		.filter((path) => path.length > 0)

const readSets = (paths: string[]) =>
	Promise.all(paths.map(async (path) => ({ path, ...(await readHeldoutDatasetRows(path)) })))

const manifests = await readSets(listed(values.datasets))
const keyed = await readSets(listed(values["key-datasets"]))

if (keyed.length && !values.extend) throw new Error("--key-datasets adds keys to an --extend list")

const added = buildEvaluationGroupsFile({
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
	keyedRows: [...manifests, ...keyed].flatMap(({ rows }) => rows),
})

let file: EvaluationGroupsFile = added

if (values.extend) {
	const base = await readLocalJSONFile<EvaluationGroupsFile>(values.extend)

	if (base.attribute !== EVALUATION_GROUPS_ATTRIBUTE || !Array.isArray(base.groups)) {
		throw new Error(`${values.extend} is not an evaluation-group file`)
	}

	const repeated = added.datasets.filter((set) => base.datasets.some((prior) => prior.datasetID === set.datasetID))

	if (repeated.length) {
		throw new Error(
			`${values.extend} already names ${repeated.map((set) => set.datasetID).join(", ")}. ` +
				`Rebuild the list from every manifest rather than extending it.`
		)
	}

	for (const { path, manifest } of keyed) {
		if (!base.datasets.some((set) => set.datasetID === manifest.datasetID && set.version === manifest.version)) {
			throw new Error(`${path} is ${manifest.datasetID}@${manifest.version}, which ${values.extend} doesn't name`)
		}
	}

	const addressKeys = [...new Set([...(base.addressKeys ?? []), ...(added.addressKeys ?? [])])].toSorted()

	file = {
		attribute: EVALUATION_GROUPS_ATTRIBUTE,
		datasets: [...base.datasets, ...added.datasets],
		groups: [...new Set([...base.groups, ...added.groups])].toSorted(),
		...(addressKeys.length ? { addressKeys } : {}),
	}
}

await writeLocalJSONFile(file, values.out)

console.log(
	`${values.out}: ${file.groups.length} groups and ${file.addressKeys?.length ?? 0} address keys from ` +
		file.datasets.map((set) => `${set.datasetID}@${set.version} (${set.rows} rows, ${set.groups} groups)`).join(", ")
)
