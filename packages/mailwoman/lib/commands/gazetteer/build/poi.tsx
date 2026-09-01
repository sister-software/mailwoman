/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build poi` — the Overture Places ingest + sealed res-9 `poi.db` layer build
 *   (spec §3.4 of the POI Data + MCP plan). Thin wiring only: the ingest (`ingestPlaces`) and
 *   materialize/seal (`buildPOIDatabase`) logic lives in `gazetteer-pipeline/poi/build-poi.ts`, so it
 *   stays unit-testable without Ink in the loop. Mirrors `overture-ingest.tsx`'s progress
 *   (stderr) / summary (stdout) split.
 *
 *   `--source osm` (decisions 3/5): a second, build-local branch alongside the default
 *   Overture path — same command, same `buildPOIDatabase` seam, different inputs. It streams
 *   `@mailwoman/osm/sdk`'s `extractOSMPOIs` over a Geofabrik `.osm.pbf` extract (telecom-infrastructure
 *   categories only), stamps the invocation's `--country` onto every row (a bare OSM feature
 *   carries no country property — see `extract-poi.ts`'s module docstring), and derives res-6 coverage
 *   by polyfilling the extract's declared `--bbox` (`bboxCoverageCells`, decision 5) rather than only
 *   the cells rows happened to land in — an infra-only extract is sparse by category, so "no plant in a
 *   well-surveyed cell" needs its own zero-observed-rows coverage row, not silent absence. The manifest
 *   swaps to `tier: build-local`, `license: ODbL-1.0`, OSM attribution — the default Overture branch
 *   below is UNTOUCHED and stays byte-identical when `--source` is omitted.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	phaseReporter,
	splitUpperList,
	useCommandTask,
} from "#cli-kit"
import type { BBox, POISourceRow } from "#gazetteer-pipeline/poi/build-poi"
import { DEFAULT_RELEASE } from "#gazetteer-pipeline/poi/defaults"
import { buildSHA as resolveBuildSHA } from "#gazetteer-pipeline/stamp-manifest"

const DEFAULT_COUNTRIES = "US,CA,MX,FR"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "poi",
	description: "Build a POI layer database",
	options: {
		source: { type: "string", choices: ["overture", "osm"], default: "overture", description: "Data source" },
		release: { type: "string", description: `Source release. Overture default ${DEFAULT_RELEASE}` },
		countries: { type: "string", description: `Overture countries. Default ${DEFAULT_COUNTRIES}` },
		out: { type: "string", description: "Output poi.db" },
		limit: { type: "string", description: "Rows per country" },
		"skip-ingest": { type: "boolean", default: false, description: "Build existing Parquet" },
		pbf: { type: "string", description: "OSM PBF extract" },
		country: { type: "string", description: "OSM country" },
		bbox: { type: "string", description: "OSM extract bounding box" },
	},
} as const satisfies CommandSpec

interface Options {
	source: "overture" | "osm"
	release?: string
	countries?: string
	out?: string
	limit?: string
	skipIngest: boolean
	pbf?: string
	country?: string
	bbox?: string
}

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

const GazetteerBuildPOI: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { LayerTier } = await import("@mailwoman/core/layers")
		const { dataRootPath } = await import("@mailwoman/core/utils")

		const { bboxCoverageCells, buildPOIDatabase, ingestPlaces } = await import("#gazetteer-pipeline/poi/build-poi")

		const buildSHA = resolveBuildSHA(String(repoRootPath()))

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

			// DYNAMIC import, required: @mailwoman/osm is UNPUBLISHED (ODbL counsel sign-off
			// pending — see osm/README.md), and this dependency belongs only on the selected build path,
			// so a top-level import breaks the whole published CLI on a clean install — the smoke
			// test's clean-install leg is what catches it. The osm source branch is build-local by
			// design; it may only resolve its SDK when actually invoked.
			const { extractOSMPOIs } = await import("@mailwoman/osm/sdk")

			for await (const row of extractOSMPOIs(pbf)) {
				// extractOSMPOIs yields `country: ""` (a bare OSM feature carries no country property) —
				// stamp the invocation's --country before buildPOIDatabase ever sees the row.
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
				`poi.db (osm/${country}): ${out} (${await formatFileSize(out)})`,
				`${result.rows.toLocaleString()} rows · ${result.categories} categories` +
					` · ${result.skipped.toLocaleString()} skipped (non-finite coords) · ${result.coverageCells.toLocaleString()} coverage cells`,
				`manifest: name=poi tier=build-local source=osm sourceVintage=${release} buildSHA=${buildSHA}`,
			]
		}

		const release = options.release ?? DEFAULT_RELEASE
		const countries = splitUpperList(options.countries ?? DEFAULT_COUNTRIES)
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
				onPhase: phaseReporter(),
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
			`poi.db: ${out} (${await formatFileSize(out)})`,
			`${result.rows.toLocaleString()} rows · ${result.categories} categories · ${result.countries.size} countries` +
				` · ${result.skipped.toLocaleString()} skipped (non-finite coords) · ${result.coverageCells.toLocaleString()} coverage cells`,
			...countryLines,
			`manifest: name=poi tier=shipped source=overture-places sourceVintage=${release} buildSHA=${buildSHA}`,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
