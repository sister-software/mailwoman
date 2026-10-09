/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build venue-heads` writes `@mailwoman/poi-taxonomy/data/venue-heads.json`,
 *   the venue head words the venue-head prior reads. `--fetch` first copies the Overture release's
 *   place names to the data root.
 */

import { dataRootPath } from "@mailwoman/core/data-root"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "venue-heads",
	description: "Build the venue head-word table from Overture place names, WOF place names and corpus streets.",
	options: {
		release: { type: "string", description: "Overture release whose place names to read", required: true },
		fetch: { type: "boolean", description: "Copy the release's place names from Overture's bucket first" },
		"corpus-manifest": {
			type: "string",
			description: "Corpus MANIFEST.json whose train split supplies street spans",
			required: true,
		},
		"candidate-db": {
			type: "string",
			description: "WOF candidate database (default $MAILWOMAN_DATA_ROOT/db/wof/candidate.db)",
		},
		out: { type: "string", description: "Output path (default the package's data/venue-heads.json)" },
	},
} as const satisfies CommandSpec

const GazetteerBuildVenueHeads: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { ingestPlaceNames, placeNamesPath } = await import("#gazetteer/poi/build/overture")
		const { buildVenueHeadTable } = await import("#gazetteer/poi/build/venue-heads")
		const log = (line: string): void => console.error(line)

		if (options.fetch) {
			await ingestPlaceNames({ release: options.release, onPhase: (_, detail) => log(detail ?? "") })
		}

		// Manifest slice paths start with the training host's `/data` root.
		// This host keeps them under the data root.
		const dataRoot = dataRootPath().toString()

		const { path, table } = await buildVenueHeadTable({
			venueNames: placeNamesPath(options.release),
			candidateDB: options.candidateDB ?? dataRootPath("db", "wof", "candidate.db").toString(),
			corpusManifest: options.corpusManifest,
			slicePath: (slice) => slice.replace(/^\/data\//, `${dataRoot}/`),
			...(options.out ? { out: options.out } : {}),
			onProgress: log,
		})

		return `${path} — ${Object.keys(table.countries).length} countries, ${Object.keys(table.languages).length} languages`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildVenueHeads
