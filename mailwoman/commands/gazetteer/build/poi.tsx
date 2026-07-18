/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build poi` — the Overture Places ingest + sealed res-9 `poi.db` layer build
 *   (spec §3.4, Task 3 of the POI Data + MCP plan). Thin wiring only: the ingest (`ingestPlaces`) and
 *   materialize/seal (`buildPOIDatabase`) logic lives in `gazetteer-pipeline/poi/build-poi.ts`, so it
 *   stays unit-testable without Ink/Pastel in the loop. Mirrors `overture-ingest.tsx`'s progress
 *   (stderr) / summary (stdout) split.
 */

import { execFileSync } from "node:child_process"

import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { artifactSizeMB } from "../../../gazetteer-pipeline/admin/index.ts"
import { buildPOIDatabase, DEFAULT_RELEASE, ingestPlaces } from "../../../gazetteer-pipeline/poi/build-poi.ts"

const DEFAULT_COUNTRIES = "US,CA,MX,FR"

const OptionsSchema = zod.object({
	release: zod.string().optional().describe(`Pinned Overture release. Default ${DEFAULT_RELEASE}`),
	countries: zod.string().optional().describe(`ISO 3166-1 alpha-2, comma-separated. Default ${DEFAULT_COUNTRIES}`),
	out: zod.string().optional().describe("poi.db output path. Default <data-root>/poi/poi.db"),
	limit: zod.string().optional().describe("Cap rows per country (debug)"),
	skipIngest: zod
		.boolean()
		.default(false)
		.describe("Skip the DuckDB/S3 ingest; build from already-materialized per-country Parquet"),
})

export { OptionsSchema as options }

const GazetteerBuildPOI: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const release = options.release ?? DEFAULT_RELEASE
		const countries = (options.countries ?? DEFAULT_COUNTRIES).split(",").map((c) => c.trim().toUpperCase())
		const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined
		const out = options.out ?? dataRootPath("poi", "poi.db")
		const buildSHA = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()

		let parquetPaths: string[]

		if (options.skipIngest) {
			console.error(`▸ skipping ingest — reading already-materialized Parquet for ${countries.join(",")} @ ${release}`)
			const outDir = dataRootPath("overture", release, "places")
			parquetPaths = countries.map((cc) => `${outDir}/places-${cc.toLowerCase()}.parquet`)
		} else {
			console.error(`▸ ingest: Overture places @ ${release} (${countries.join(",")})`)
			const ingest = await ingestPlaces({
				release,
				countries,
				limit,
				onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
			})
			parquetPaths = countries.map((cc) => ingest.countryParquet[cc]).filter((p): p is string => Boolean(p))
		}

		console.error(`▸ build: ${out}`)
		const result = await buildPOIDatabase({
			parquetPaths,
			out,
			release,
			buildSHA,
			createdAt: new Date().toISOString(),
			onProgress: (phase, message) => console.error(`  [${phase}] ${message}`),
		})

		const countryLines = [...result.countries.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([cc, count]) => `  ${cc} ${count.toLocaleString()}`)

		return [
			`poi.db: ${out} (${artifactSizeMB(out)} MB)`,
			`${result.rows.toLocaleString()} rows · ${result.categories} categories · ${result.countries.size} countries` +
				` · ${result.skipped.toLocaleString()} skipped (non-finite coords) · ${result.coverageCells.toLocaleString()} coverage cells`,
			...countryLines,
			`manifest: name=poi tier=shipped source=overture-places sourceVintage=${release} buildSHA=${buildSHA}`,
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

export default GazetteerBuildPOI
