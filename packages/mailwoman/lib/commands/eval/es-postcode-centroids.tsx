/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval es-postcode-centroids` builds per-postcode centroid `spr` DBs from a local
 *   Overture addresses parquet, the `--postcodes` inputs that releasing.md's candidate-gazetteer
 *   recipe cites. Despite the historical `es-` name, the `--country` flag covers every locale with
 *   adequate Overture postcode fill. Use `--pc-len 0` for the Overture-to-Overture or non-numeric
 *   formats. The command needs the optional `@duckdb/node-api` peer dep and is maintainer-only.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Build Overture-derived postcode-centroid spr DBs (#474)"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "es-postcode-centroids",
	description,
	options: {
		country: { type: "string", default: "ES", description: "ISO country code (selects the parquet + output name)" },
		"pc-len": { type: "number", description: "Postcode lpad width; 0 = no lpad (default 5)" },
		parquet: {
			type: "string",
			description: "Overture addresses parquet (default: the pinned release under the data root)",
		},
		out: { type: "string", description: "Output SQLite DB (default <data-root>/db/wof/postalcode-<cc>-overture.db)" },
	},
} as const satisfies CommandSpec

// The builder narrates row counts on stderr, so no `json`.
const EvalESPostcodeCentroids = harnessCommand(spec, async (options) => {
	const { buildESPostcodeCentroids } = await import("#eval-harness/es-postcode-centroids")

	return buildESPostcodeCentroids(options)
})

export default EvalESPostcodeCentroids
