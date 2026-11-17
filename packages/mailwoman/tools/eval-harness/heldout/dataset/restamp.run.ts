// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Rewrites a frozen dataset manifest's version under the rule that hashes its
 *   rows (`heldoutDatasetVersion` in `manifest.ts`), after checking the rows
 *   file against the sha256 the manifest records.
 *   The rows file isn't touched.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/restamp.run.ts \
 *     --dataset <dataset manifest .json> [--excludes <restamped manifest .json>] [--check]
 *
 *   `--check` prints the new version without writing.
 *   With `--excludes-version <v>` it computes a confirmation set's version
 *   against a development set not yet restamped.
 *
 *   A confirmation set drawn against a development set records the development version in
 *   `sampling.excludes`; restamp the development set first and pass its manifest as `--excludes`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import {
	type HeldoutDatasetManifest,
	readHeldoutDatasetManifest,
	restampHeldoutDataset,
} from "#tools/eval-harness/heldout/dataset/manifest"

const { values } = parseArguments({
	options: {
		dataset: { type: "string", description: "The dataset manifest to restamp" },
		excludes: {
			type: "string",
			description: "The restamped manifest whose groups this set was drawn without",
		},
		"excludes-version": {
			type: "string",
			description: "With --check, the version the excluded set would carry once restamped, in place of --excludes",
		},
		check: {
			type: "boolean",
			description: "Print the version the manifest would carry without writing it",
		},
	},
})

if (!values.dataset) throw new Error("--dataset is required")

const excludes = await (async () => {
	if (values.excludes) return readHeldoutDatasetManifest(values.excludes)

	if (!values["excludes-version"]) return null

	if (!values.check) throw new Error("--excludes-version is for --check; a restamp reads the restamped --excludes")

	const recorded = (await readLocalJSONFile<HeldoutDatasetManifest>(values.dataset!)).sampling.excludes

	if (!recorded) throw new Error(`${values.dataset} excludes no dataset`)

	return { datasetID: recorded.datasetID, version: values["excludes-version"] }
})()

const { manifest, previous } = await restampHeldoutDataset(values.dataset, excludes, !values.check)

console.log(
	`${manifest.datasetID}: version ${previous} -> ${manifest.version}${values.check ? " (not written)" : ""}, ` +
		`rows sha256 ${manifest.rowsFile.sha256}` +
		(excludes ? `, excludes ${excludes.datasetID}@${excludes.version}` : "")
)
