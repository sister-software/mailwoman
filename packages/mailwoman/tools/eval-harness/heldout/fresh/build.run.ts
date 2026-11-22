// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches every evaluation-only source and freezes the fresh-source evaluation set.
 *
 *   Usage: node packages/mailwoman/tools/eval-harness/heldout/fresh/build.run.ts --out
 *   <directory> [--fetch] [--per-country 2000] [--floor 20] [--seed 2026] [--sources-root <root>]
 *
 *   `--fetch` downloads each source into `<sources-root>/<source id>/` first.
 *   Without it, the build reads what an earlier fetch left there.
 *
 *   The set's manifest, rows and lineage are written under `--out`.
 *   Audit it with `heldout/dataset/overlap.run.ts --match-text` before reading a score from it.
 */

import { currentSourcesRoot } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { EVALUATION_SOURCES } from "@mailwoman/corpus/evaluation/sources"
import { readCorpusSourceInputs } from "@mailwoman/corpus/source-register/corpus-inputs"
import { readAddressSourceRegister } from "@mailwoman/corpus/source-register/register"
import { readCommittedTrainingManifests, trainedRegisterSources } from "@mailwoman/corpus/source-register/reservations"
import { PathBuilder } from "path-ts"

import { buildFreshSourceSet } from "#tools/eval-harness/heldout/fresh/build"

const { values } = parseArguments({
	options: {
		out: { type: "string", description: "The directory the set is written to" },
		fetch: { type: "boolean", description: "Download every source before building" },
		"per-country": { type: "string", default: "2000", description: "Rows drawn per country" },
		floor: { type: "string", default: "20", description: "Rows every stratum takes before the proportional split" },
		seed: { type: "string", default: "2026", description: "An integer mixed into the draw order" },
		"sources-root": {
			type: "string",
			description: "The root each source's fetch writes under (default: the cache root's sources/)",
		},
	},
})

if (!values.out) throw new Error("--out <directory> is required")

const integer = (name: string, value: string | undefined) => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} ${value} is not a whole number`)

	return parsed
}

const sourcesRoot = values["sources-root"] ? PathBuilder.from(values["sources-root"]) : currentSourcesRoot()

if (values.fetch) {
	for (const source of EVALUATION_SOURCES) {
		console.log(`=== fetch ${source.id}`)

		await source.fetch(sourcesRoot(source.id), (line) => console.log(line))
	}
}

const register = await readAddressSourceRegister()

const { readers: trained, unmapped } = trainedRegisterSources(
	await readCommittedTrainingManifests(),
	await readCorpusSourceInputs(register)
)

if (unmapped.length) {
	throw new Error(
		`corpus-source-inputs.json does not map ${unmapped.length} training manifest source(s), so whether they ` +
			`read an evaluation source cannot be read: ${unmapped.join(", ")}`
	)
}

const built = await buildFreshSourceSet({
	sources: EVALUATION_SOURCES,
	register,
	trained,
	sourcesRoot,
	outDirectory: values.out,
	perCountry: integer("per-country", values["per-country"]),
	floor: integer("floor", values.floor),
	seed: integer("seed", values.seed),
	createdAt: new Date().toISOString(),
})

console.log(
	`${built.manifest.datasetID} version ${built.manifest.version}: ${built.manifest.rows.length.toLocaleString("en-US")} rows, ` +
		`rows sha256 ${built.manifest.rowsFile.sha256}`
)

for (const source of built.sources) {
	const drawn = source.strata.reduce((n, s) => n + s.drawn, 0)

	console.log(
		`  ${source.id} (${source.country}) @ ${source.vintage}: ${source.records} records, ${source.available} distinct texts, ` +
			`${drawn} drawn over ${source.strata.length} strata; refused ${stringifyJSON(source.refused)}`
	)
}
