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
import { useEffect, useState } from "react"
import zod from "zod"

import { artifactSizeMB, buildPostcodeShard } from "../../../gazetteer-pipeline/index.js"
import type { CommandComponent } from "../../../sdk/cli.js"

const OptionsSchema = zod.object({
	country: zod.string().describe("ISO-2 country (the whosonfirst-data-postalcode-<cc> repo to build)"),
	out: zod.string().optional().describe("Output path. Default <data-root>/wof/postalcode-<cc>.REBUILD.db"),
	repos: zod.string().optional().describe("WOF repos root. Default <data-root>/wof/repos"),
	zcta: zod.string().optional().describe("Census ZCTA Gazetteer file (US). Default <data-root>/census/…"),
	geonamesPostal: zod.string().optional().describe("GeoNames postal dump dir. Default <data-root>/geonames-postal"),
	admin: zod.string().optional().describe("Admin gazetteer for parent borrows. Default the live admin DB"),
})

export { OptionsSchema as options }

const GazetteerBuildPostcodeShard: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const result = await buildPostcodeShard({
					country: options.country,
					out: options.out,
					reposDir: options.repos,
					zctaPath: options.zcta,
					geonamesPostalDir: options.geonamesPostal,
					adminPath: options.admin,
					onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
				})

				setSummary([
					`postcode shard: ${result.out} (${artifactSizeMB(result.out)} MB)`,
					`${result.postcodesIngested.toLocaleString()} postcodes; placed ${result.fills.placedBefore.toLocaleString()} → ${result.fills.placedAfter.toLocaleString()} of ${result.fills.total.toLocaleString()}` +
						(result.zctaFilled
							? ` (zcta ${result.zctaFilled.toLocaleString()}` +
								(result.geonamesUSFilled ? `, geonames-us ${result.geonamesUSFilled.toLocaleString()}` : "") +
								")"
							: ""),
					"sealed 0444",
					"next: swap per RELEASING.md (postcode shards ride wofShardPaths)",
				])
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
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
