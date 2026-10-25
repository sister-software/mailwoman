/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds a generation of the place autocomplete index into a staged directory the public-bucket publisher uploads:
 *
 *   node packages/mailwoman/tools/dev-tools/data/autocomplete-index.run.ts --out <stage> --version 2026-10-24
 *   [--candidate-db <path>] [--floor 20000]
 *
 *   Then publish the stage with `publish-public-bucket.run.ts --src <stage>` and bump
 *   `AUTOCOMPLETE_INDEX_VERSION` in `packages/mailwoman/lib/browser-runtime/resources.ts`.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"

import { buildAutocompleteIndex, DEFAULT_POPULATION_FLOOR } from "#tools/release-tools/publish/autocomplete-index"

const { values } = parseArguments({
	options: {
		out: { type: "string", description: "The staged directory the public-bucket publisher uploads" },
		version: { type: "string", description: "The generation, a date such as 2026-10-24" },
		"candidate-db": { type: "string", description: "The candidate gazetteer to read; the data root's by default" },
		floor: {
			type: "string",
			description: "The population floor a place needs; countries and regions enter regardless",
		},
	},
})

if (!values.out || !values.version) {
	throw new CommandError("autocomplete-index: --out <stage directory> and --version <generation> are required")
}

const floor = values.floor === undefined ? DEFAULT_POPULATION_FLOOR : Number(values.floor)

if (!Number.isFinite(floor) || floor < 0) {
	throw new CommandError(`autocomplete-index: --floor must be a non-negative number, got ${values.floor}`)
}

const candidateDB = values["candidate-db"] ?? wofDatabasePath("candidate.db")
const started = performance.now()
const manifest = await buildAutocompleteIndex({ candidateDB, outDir: values.out, version: values.version, floor })
const totalBytes = Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0)

console.log(
	`autocomplete index ${manifest.version}: ${manifest.entries.toLocaleString("en-US")} entries in ` +
		`${Object.keys(manifest.files).length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB before encoding, ` +
		`floor ${floor.toLocaleString("en-US")}, from ${candidateDB}, in ${((performance.now() - started) / 1000).toFixed(0)} s`
)

for (const [partition, file] of Object.entries(manifest.files)
	.toSorted(([, a], [, b]) => b.bytes - a.bytes)
	.slice(0, 8)) {
	console.log(`  ${partition}: ${file.entries.toLocaleString("en-US")} entries, ${(file.bytes / 1024).toFixed(0)} KB`)
}
