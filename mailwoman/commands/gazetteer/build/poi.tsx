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
 *
 *   `--source osm` (bdc 2b task 3, decisions 3/5): a second, build-local branch alongside the default
 *   Overture path — same command, same `buildPOIDatabase` seam, different inputs. It streams
 *   `@mailwoman/osm/sdk`'s `extractOSMPOIs` over a Geofabrik `.osm.pbf` extract (telecom-infrastructure
 *   categories only, task 2), stamps the invocation's `--country` onto every row (a bare OSM feature
 *   carries no country property — see `extract-poi.ts`'s module docstring), and derives res-6 coverage
 *   by polyfilling the extract's declared `--bbox` (`bboxCoverageCells`, decision 5) rather than only
 *   the cells rows happened to land in — an infra-only extract is sparse by category, so "no plant in a
 *   well-surveyed cell" needs its own zero-observed-rows coverage row, not silent absence. The manifest
 *   swaps to `tier: build-local`, `license: ODbL-1.0`, OSM attribution — the default Overture branch
 *   below is UNTOUCHED and stays byte-identical when `--source` is omitted.
 */

import { execFileSync } from "node:child_process"

import { LayerTier } from "@mailwoman/core/layers"
import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { artifactSizeMB } from "../../../gazetteer-pipeline/admin/index.ts"
import {
	bboxCoverageCells,
	buildPOIDatabase,
	DEFAULT_RELEASE,
	ingestPlaces,
	type BBox,
	type POISourceRow,
} from "../../../gazetteer-pipeline/poi/build-poi.ts"

const DEFAULT_COUNTRIES = "US,CA,MX,FR"

const OptionsSchema = zod.object({
	source: zod
		.enum(["overture", "osm"])
		.default("overture")
		.describe("Data source: overture (default, shipped) or osm (build-local, ODbL — requires --pbf/--country/--bbox)"),
	release: zod
		.string()
		.optional()
		.describe(`overture: pinned release, default ${DEFAULT_RELEASE}. osm: the extract's vintage/date tag (required)`),
	countries: zod
		.string()
		.optional()
		.describe(`overture only: ISO 3166-1 alpha-2, comma-separated. Default ${DEFAULT_COUNTRIES}`),
	out: zod
		.string()
		.optional()
		.describe("poi.db output path. Default <data-root>/poi/poi.db (overture) or poi/poi-osm-<cc>.db (osm)"),
	limit: zod.string().optional().describe("overture only: cap rows per country (debug)"),
	skipIngest: zod
		.boolean()
		.default(false)
		.describe("overture only: skip the DuckDB/S3 ingest; build from already-materialized per-country Parquet"),
	pbf: zod.string().optional().describe("osm: path to a Geofabrik .osm.pbf extract (required)"),
	country: zod
		.string()
		.optional()
		.describe("osm: ISO 3166-1 alpha-2 country stamped onto every extracted row (required)"),
	bbox: zod
		.string()
		.optional()
		.describe("osm: extract bounding box as 'minLon,minLat,maxLon,maxLat' — polyfills res-6 coverage cells (required)"),
})

export { OptionsSchema as options }

/**
 * `--bbox` field count: `minLon,minLat,maxLon,maxLat`.
 */
const BBOX_FIELD_COUNT = 4

/**
 * Parse `--bbox "minLon,minLat,maxLon,maxLat"` into a {@link BBox}. Throws with the raw input echoed back on any
 * shape/finiteness mismatch — a silently-mis-parsed bbox would corrupt coverage silently, so fail loud instead.
 */
function parseBBoxFlag(raw: string): BBox {
	const parts = raw.split(",").map((s) => Number(s.trim()))

	if (parts.length !== BBOX_FIELD_COUNT || parts.some((n) => !Number.isFinite(n))) {
		throw new Error(
			`--bbox must be 4 comma-separated numbers "minLon,minLat,maxLon,maxLat", got ${JSON.stringify(raw)}`
		)
	}

	const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]

	return { minLon, minLat, maxLon, maxLat }
}

const GazetteerBuildPOI: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const buildSHA = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()

		if (options.source === "osm") {
			const { pbf, country: rawCountry, release, bbox: bboxFlag } = options

			if (!pbf || !rawCountry || !release || !bboxFlag) {
				throw new Error(
					"gazetteer build poi --source osm requires --pbf <extract.osm.pbf> --country <cc> --release <vintage> " +
						"--bbox <minLon,minLat,maxLon,maxLat>"
				)
			}

			const country = rawCountry.trim().toUpperCase()
			const bbox = parseBBoxFlag(bboxFlag)
			const out = options.out ?? dataRootPath("poi", `poi-osm-${country.toLowerCase()}.db`)

			console.error(`▸ extract: OSM telecom-infrastructure POIs from ${pbf} (country=${country})`)

			// Buffered (not streamed straight into buildPOIDatabase): telecom-infra extracts are
			// category-sparse — a few thousand rows even for a whole country — and the array is walked
			// twice, once here to derive coverage, once as buildPOIDatabase's `rows` seam.
			const rows: POISourceRow[] = []

			// DYNAMIC import, load-bearing: @mailwoman/osm is UNPUBLISHED (ODbL counsel sign-off
			// pending — see osm/README.md), and Pastel loads every command module eagerly on --help,
			// so a top-level import breaks the whole published CLI on a clean install (caught by the
			// smoke test's clean-install leg, 2026-07-31). The osm source branch is build-local by
			// design; it may only resolve its SDK when actually invoked.
			const { extractOSMPOIs } = await import("@mailwoman/osm/sdk")

			for await (const row of extractOSMPOIs(pbf)) {
				// Task 3 hand-off from task 2: extractOSMPOIs yields `country: ""` (a bare OSM feature
				// carries no country property) — stamp the invocation's --country before buildPOIDatabase
				// ever sees the row.
				rows.push({ ...row, country })
			}

			console.error(`▸ build: ${out}`)

			const coverageCellsOverride = bboxCoverageCells(bbox, rows)

			const result = await buildPOIDatabase({
				rows,
				out,
				release,
				buildSHA,
				source: "osm",
				tier: LayerTier.BuildLocal,
				coverageCellsOverride,
				createdAt: new Date().toISOString(),
				onProgress: (phase, message) => console.error(`  [${phase}] ${message}`),
			})

			return [
				`poi.db (osm/${country}): ${out} (${artifactSizeMB(out)} MB)`,
				`${result.rows.toLocaleString()} rows · ${result.categories} categories` +
					` · ${result.skipped.toLocaleString()} skipped (non-finite coords) · ${result.coverageCells.toLocaleString()} coverage cells`,
				`manifest: name=poi tier=build-local source=osm sourceVintage=${release} buildSHA=${buildSHA}`,
			]
		}

		const release = options.release ?? DEFAULT_RELEASE
		const countries = (options.countries ?? DEFAULT_COUNTRIES).split(",").map((c) => c.trim().toUpperCase())
		const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined
		const out = options.out ?? dataRootPath("poi", "poi.db")

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
			.toSorted(([a], [b]) => a.localeCompare(b))
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
