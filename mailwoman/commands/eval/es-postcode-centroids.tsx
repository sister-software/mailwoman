/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval es-postcode-centroids` — build per-postcode centroid `spr` DBs from a local
 *   Overture addresses parquet (#474; the `--postcodes` inputs RELEASING.md's candidate-gazetteer
 *   recipe cites). Despite the historical `es-` name the `--country` flag covers every locale with
 *   adequate Overture postcode fill; use `--pc-len 0` for the Overture-to-Overture / non-numeric
 *   formats. Needs the optional `@duckdb/node-api` peer dep (maintainer-only data command).
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { buildESPostcodeCentroids } from "../../eval-harness/es-postcode-centroids.ts"

export const description = "Build Overture-derived postcode-centroid spr DBs (#474)"

const OptionsSchema = zod.object({
	country: zod.string().default("ES").describe("ISO country code (selects the parquet + output name)"),
	pcLen: zod.number().optional().describe("Postcode lpad width; 0 = no lpad (default 5)"),
	parquet: zod
		.string()
		.optional()
		.describe("Overture addresses parquet (default: the pinned release under the data root)"),
	out: zod.string().optional().describe("Output SQLite DB (default <data-root>/wof/postcode-<cc>-overture.db)"),
})

export { OptionsSchema as options }

const EvalESPostcodeCentroids: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => buildESPostcodeCentroids(options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The builder narrates row counts on stderr.
	return null
}

export default EvalESPostcodeCentroids
