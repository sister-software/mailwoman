// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes a new collection from a frozen one under a recorded answer-key revision
 *   (`heldout/dataset/relabel.ts`), leaving the source collection as it is.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/relabel.run.ts \
 *     --source <dataset manifest .json> --out <new manifest .json> --relabel county-in-locality-slot-subregion \
 *     [--excludes <restamped manifest .json> | --excludes-version <v>] [--check]
 *
 *   The new manifest keeps the source's datasetID, sampling and drawn-from record, takes a version
 *   from its own rows, and records the source, the rule and every changed row in `revision`.
 *   A source frozen under schema 1 is restamped in memory, and its file stays as it is.
 *
 *   A confirmation set records the development set it was drawn without.
 *   `--excludes` reads that set's restamped manifest.
 *
 *   `--excludes-version` gives the version it records under the current rule
 *   (`restamp.run.ts --check`) while it isn't restamped yet.
 *   The same collection is the one the new manifest records.
 *
 *   `--check` prints the changed rows and the new version without writing.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import {
	type HeldoutDatasetManifest,
	readHeldoutDatasetManifest,
	reviseHeldoutDataset,
} from "#tools/eval-harness/heldout/dataset/manifest"
import { COUNTY_IN_LOCALITY_SLOT, type HeldoutRelabel } from "#tools/eval-harness/heldout/dataset/relabel"

const RELABELS: Record<string, HeldoutRelabel> = {
	[COUNTY_IN_LOCALITY_SLOT.id]: COUNTY_IN_LOCALITY_SLOT,
}

const { values } = parseArguments({
	options: {
		source: { type: "string", description: "The frozen collection's manifest" },
		out: { type: "string", description: "Where to write the new manifest; its rows file goes beside it" },
		relabel: { type: "string", description: `The revision to apply: ${Object.keys(RELABELS).join(", ")}` },
		excludes: { type: "string", description: "The restamped manifest whose groups the source was drawn without" },
		"excludes-version": {
			type: "string",
			description: "The version the excluded set carries under the current rule, in place of --excludes",
		},
		check: { type: "boolean", description: "Print the changed rows and the version without writing" },
	},
})

if (!values.source || !values.out || !values.relabel) throw new Error("--source, --out and --relabel are required")

const relabel = RELABELS[values.relabel]

if (!relabel) throw new Error(`no revision ${values.relabel}; known: ${Object.keys(RELABELS).join(", ")}`)

const excludes = await (async () => {
	if (values.excludes) return readHeldoutDatasetManifest(values.excludes)

	if (!values["excludes-version"]) return null

	const recorded = (await readLocalJSONFile<HeldoutDatasetManifest>(values.source!)).sampling.excludes

	if (!recorded) throw new Error(`${values.source} excludes no dataset`)

	return { datasetID: recorded.datasetID, version: values["excludes-version"] }
})()

const manifest = await reviseHeldoutDataset(
	values.source,
	values.out,
	{
		rule: relabel.rule,
		annotation: `relabel:${relabel.id}`,
		revise: relabel.revise,
		sourceExcludes: excludes,
		excludes,
		createdAt: new Date().toISOString(),
	},
	!values.check
)

const revision = manifest.revision!

for (const row of revision.rows) {
	console.log(`${row.rowID}\t${row.before.join(" | ")}\t->\t${row.after.join(" | ")}`)
}

console.log(
	`${manifest.datasetID}: ${revision.from.version} -> ${manifest.version}${values.check ? " (not written)" : ""}, ` +
		`${revision.rows.length} rows changed, rows sha256 ${manifest.rowsFile.sha256}` +
		(excludes ? `, excludes ${excludes.datasetID}@${excludes.version}` : "")
)
