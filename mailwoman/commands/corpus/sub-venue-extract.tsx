/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus sub-venue-extract` — run the sub-venue structure extractor over one Geofabrik
 *   `.osm.pbf` and write the rows as JSONL, the input `mailwoman corpus sub-venue-lexicon` reads.
 *
 *   Wave 1 did this with an ad-hoc script because it ran once. Wave 2 runs it per locale, and the
 *   country stamp is an argument nobody can infer from the file — a Geofabrik extract's country is a
 *   property of the invocation, not of a feature — so it belongs behind a flag rather than in shell
 *   history.
 *
 *   ```sh
 *   mailwoman corpus sub-venue-extract \
 *     --pbf     $MAILWOMAN_DATA_ROOT/sub-venue/pbf/japan.osm.pbf \
 *     --out     $MAILWOMAN_DATA_ROOT/sub-venue/extracts/japan.jsonl \
 *     --country JP
 *   ```
 *
 *   Needs `ogr2ogr` on PATH (GDAL 3.8.4 on the lab box). Runtime is dominated by GDAL: 44 s for a
 *   340 MB extract, 371 s for Japan's 2.5 GB.
 */

import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	pbf: zod.string().describe("Geofabrik .osm.pbf extract to read"),
	out: zod.string().describe("Destination JSONL"),
	country: zod.string().optional().describe("ISO 3166-1 alpha-2 stamped onto every row"),
})

export { OptionsSchema as options }

const CorpusSubVenueExtract: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		// @mailwoman/osm is a devDependency ONLY — it is unpublished (ODbL counsel sign-off pending,
		// see osm/README.md), so a static import here breaks every clean install of the published
		// CLI (the 2026-08-05 smoke failure). Lazy-load it and fail with provenance when absent.
		const { writeSubVenueJSONL } = await import("@mailwoman/osm/sdk").catch(() => {
			throw new Error(
				"corpus sub-venue-extract requires @mailwoman/osm, which is not yet published — " +
					"run this command from the mailwoman monorepo (osm/README.md has the publish status)."
			)
		})

		return writeSubVenueJSONL({ pbfPath: options.pbf, outPath: options.out, country: options.country })
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				{options.out}: {state.result} rows
			</Text>
		)
	}

	return null
}

export default CorpusSubVenueExtract
