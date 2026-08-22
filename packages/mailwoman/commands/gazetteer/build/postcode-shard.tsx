/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-shard --country <cc>` — one country's WOF postcode shard
 *   (`postalcode-<cc>.db`): repo ingest → centroid-fill ladder (US: Census ZCTA + GeoNames; all:
 *   GeoNames postal → admin parent-borrow → hierarchy-ancestor fallback) → FTS → SEAL. Replaces the
 *   reopen-and-mutate `fill-zcta-centroids` / `backfill-postcode-centroids` scripts — fills are build
 *   steps now. GeoNames-sourced rows are CC-BY 4.0 (attribute "GeoNames (CC-BY 4.0)").
 */

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-shard",
	description: "Build one country's WOF postcode shard.",
	options: {
		country: {
			type: "string",
			required: true,
			description: "ISO-2 country (the whosonfirst-data-postalcode-<cc> repo to build)",
		},
		out: { type: "string", description: "Output path. Default <data-root>/wof/postalcode-<cc>.REBUILD.db" },
		repos: { type: "string", description: "WOF repos root. Default <data-root>/wof/repos" },
		zcta: { type: "string", description: "Census ZCTA Gazetteer file (US). Default <data-root>/census/…" },
		"geonames-postal": { type: "string", description: "GeoNames postal dump dir. Default <data-root>/geonames-postal" },
		admin: { type: "string", description: "Admin gazetteer for parent borrows. Default the live admin DB" },
	},
} as const satisfies CommandSpec

interface Options {
	country: string
	out?: string
	repos?: string
	zcta?: string
	geonamesPostal?: string
	admin?: string
}

const GazetteerBuildPostcodeShard: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { artifactSizeMB, buildPostcodeShard } = await import("#gazetteer-pipeline")

		const result = await buildPostcodeShard({
			country: options.country,
			out: options.out,
			reposDir: options.repos,
			zctaPath: options.zcta,
			geonamesPostalDir: options.geonamesPostal,
			adminPath: options.admin,
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		return [
			`postcode shard: ${result.out} (${artifactSizeMB(result.out)} MB)`,
			`${result.postcodesIngested.toLocaleString()} postcodes; placed ${result.fills.placedBefore.toLocaleString()} → ${result.fills.placedAfter.toLocaleString()} of ${result.fills.total.toLocaleString()}` +
				(result.zctaFilled
					? ` (zcta ${result.zctaFilled.toLocaleString()}` +
						(result.geonamesUSFilled ? `, geonames-us ${result.geonamesUSFilled.toLocaleString()}` : "") +
						")"
					: ""),
			"sealed 0444",
			"next: swap per RELEASING.md (postcode shards ride wofShardPaths)",
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildPostcodeShard
