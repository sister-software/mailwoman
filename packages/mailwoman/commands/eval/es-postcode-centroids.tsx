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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Build Overture-derived postcode-centroid spr DBs (#474)"

/**
 * Native command-line contract consumed by the filesystem command router.
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
		out: { type: "string", description: "Output SQLite DB (default <data-root>/wof/postalcode-<cc>-overture.db)" },
	},
} as const satisfies CommandSpec

interface Options {
	country: string
	pcLen?: number
	parquet?: string
	out?: string
}

const EvalESPostcodeCentroids: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildESPostcodeCentroids } = await import("#eval-harness/es-postcode-centroids")

		return buildESPostcodeCentroids(options)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The builder narrates row counts on stderr.
	return null
}

export default EvalESPostcodeCentroids
