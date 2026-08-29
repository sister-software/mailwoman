/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build soil` — acquire NRCS's SSURGO survey areas for a region and build the sealed
 *   `soil.db` layer. Thin wiring only: the catalogue read, the downloads, the metadata, the build and the
 *   verification all live in `@mailwoman/soil/sdk`, so each stays unit-testable without Ink or the network
 *   in the loop.
 *
 *   THE REGION IS A SURVEY-AREA PREFIX, WHICH IS THE AUTHORITY'S OWN UNIT. `--region IA` builds every Iowa
 *   survey area; `--area IA153` builds one. That mirrors `gazetteer build bdc --state`, and it is what makes
 *   the manifest's declared extent and the coverage rows describe the same set — a list of published survey
 *   areas rather than "the United States".
 *
 *   `--measure-resolutions` DOES NOT BUILD. The index resolution is a measurement this layer takes rather
 *   than a number argued to, and running it is a mode of its own because it produces a table, not an
 *   artifact. It reports the `partial` share and the mean delineations per cell; the SECOND number §4.7 asks
 *   for — the share of cells whose top class holds under half the cell — needs the attribute join and the
 *   area weighting, so it comes off the built artifact instead and rides in the build summary.
 *
 *   `--area` IS THE SMOKE RUNG. One real survey area, from the real archive, which verifies what fixtures
 *   structurally cannot: the shapefile's field names, that the `.prj` really resolves to EPSG:4326, that the
 *   pipe-delimited export parses with its embedded newlines intact, that `mukey` joins spatial to tabular,
 *   and the seal.
 */

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Coverage resolution. Res 6 matches what the POI and flood layers write, so a reader already keyed to another layer's
 * coverage cells finds these without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * Index resolution, chosen from the measurement — see the workspace README for the table and the reasoning.
 * `--measure-resolutions` re-derives it.
 */
const DEFAULT_INDEX_RESOLUTION = "9"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "soil",
	description: "Build the NRCS SSURGO soil-capability layer",
	options: {
		region: { type: "string", description: "Survey-area symbol prefix, e.g. IA" },
		area: { type: "string", description: "One survey area, e.g. IA153 — the smoke rung" },
		out: { type: "string", description: "soil.db output path" },
		"index-resolution": { type: "string", default: DEFAULT_INDEX_RESOLUTION, description: "H3 index resolution" },
		"coverage-resolution": {
			type: "string",
			default: DEFAULT_COVERAGE_RESOLUTION,
			description: "H3 coverage resolution",
		},
		"measure-resolutions": { type: "string", description: "Measure the partial share at these resolutions and stop" },
		"chunk-size": { type: "string", description: "Delineation ids per ingest process (default 100000)" },
		verify: { type: "boolean", default: false, description: "Run the Soil Data Access agreement check after building" },
		"verify-only": { type: "boolean", default: false, description: "Check an already-sealed --out and build nothing" },
		"verify-points": { type: "string", description: "How many points to re-ask the service about (default 60)" },
	},
} as const satisfies CommandSpec

interface Options {
	region?: string
	area?: string
	out?: string
	indexResolution: string
	coverageResolution: string
	measureResolutions?: string
	chunkSize?: string
	verify: boolean
	verifyOnly: boolean
	verifyPoints?: string
}

/**
 * Both halves of the check, as the summary lines they produce.
 *
 * A function rather than an inline block because two modes reach it: the tail of a build, and `--verify-only` against
 * an artifact some earlier run sealed.
 */
async function runVerification(
	databasePath: string,
	client: Parameters<typeof import("@mailwoman/soil/sdk").verifySoilDatabase>[0]["client"],
	count?: number
): Promise<string[]> {
	const { sampleAgreementPoints, verifySoilDatabase } = await import("@mailwoman/soil/sdk")

	const points = sampleAgreementPoints(databasePath, count === undefined ? {} : { count })

	const verified = await verifySoilDatabase({
		databasePath,
		client,
		points,
		onProgress: (message) => console.error(`  [verify] ${message}`),
	})

	// A disagreement count is not actionable on its own — the rows are. Printed to stderr with the progress stream,
	// because the first thing anyone does with a non-zero count is ask which points.
	for (const row of verified.agreement.filter((entry) => entry.outcome === "disagree")) {
		console.error(
			`  [verify] disagree at ${row.latitude}, ${row.longitude} (${row.label}): artifact ${row.localMukey ?? "no map unit"}, ` +
				`service ${row.serviceMukey ?? "no map unit"}, ${row.nearestEdgeMetres?.toFixed(3) ?? "?"} m to the nearest edge`
		)
	}

	return [
		`verify: ${verified.agreed}/${verified.agreement.length} agree with Soil Data Access · ` +
			`${verified.boundaryTolerance} within boundary tolerance · ${verified.disagreed} disagree`,
		`verify (outside the built survey areas): ${verified.outsidePassed}/${verified.outside.length} read unknown` +
			(verified.outside.some((row) => !row.passed)
				? `, ${verified.outside
						.filter((row) => !row.passed)
						.map((row) => row.label)
						.join(", ")} did not`
				: ""),
	]
}

const GazetteerBuildSoil: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { execFileSync } = await import("@mailwoman/platform/child_process")

		const { artifactSizeMB } = await import("#gazetteer-pipeline/admin/index")
		const { dataRootPath } = await import("@mailwoman/core/utils")

		const {
			acquireRegion,
			buildSoilDatabase,
			createSoilDataAccessClient,
			formatSoilResolutionRows,
			measureSoilCellResolutions,
		} = await import("@mailwoman/soil/sdk")

		const { SOIL_PILOT_REGION, soilLayerName, SSURGO_ATTRIBUTION, SSURGO_LICENSE } =
			await import("@mailwoman/soil/vocabulary")

		if (options.region && options.area) {
			throw new Error(
				"gazetteer build soil: pass --region or --area, not both — a build's declared extent is the set it built, and two ways of naming it is two answers"
			)
		}

		const prefix = options.area ?? options.region ?? SOIL_PILOT_REGION.toUpperCase()
		const region = options.area ? options.area.toLowerCase() : prefix.toLowerCase()
		const client = createSoilDataAccessClient()

		// `--verify-only` CHECKS AN ARTIFACT THAT ALREADY EXISTS and acquires nothing. A full-region build takes hours and
		// seals its artifact before the check runs, so a check that could only run as the build's last step would cost a
		// rebuild every time the check itself was worth re-running.
		if (options.verifyOnly) {
			return runVerification(
				options.out ?? String(dataRootPath("soil", "soil.db")),
				client,
				options.verifyPoints ? Number(options.verifyPoints) : undefined
			)
		}

		const acquired = await acquireRegion({
			client,
			prefix,
			cacheRoot: String(dataRootPath("soil", "cache", "archives")),
			onProgress: (message) => console.error(`  [acquire] ${message}`),
		})

		console.error(`▸ product vintage: ${acquired.sourceVintage} (${acquired.areas.length} survey area(s))`)

		if (options.measureResolutions) {
			const resolutions = options.measureResolutions.split(",").map((value) => Number(value.trim()))
			const lines: string[] = []

			for (const area of acquired.areas) {
				if (!area.shapefilePath) {
					throw new Error(
						`gazetteer build soil: ${area.attributes.areasymbol} was acquired without a shapefile path, so there is nothing to measure`
					)
				}

				const report = await measureSoilCellResolutions({
					shapefilePath: area.shapefilePath,
					resolutions,
					onProgress: (message) => console.error(`  [measure] ${message}`),
				})

				lines.push(
					`${area.attributes.areasymbol}: ${report.delineations.toLocaleString()} delineations`,
					...formatSoilResolutionRows(report.measurements)
				)
			}

			return lines
		}

		const coverageResolution = Number(options.coverageResolution)
		const indexResolution = Number(options.indexResolution)
		const out = options.out ?? String(dataRootPath("soil", "soil.db"))
		const buildSHA = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()

		const buildCmd =
			`mailwoman gazetteer build soil ${options.area ? `--area ${options.area}` : `--region ${prefix}`} ` +
			`--index-resolution ${indexResolution} --coverage-resolution ${coverageResolution}`

		const result = await buildSoilDatabase({
			areas: acquired.areas,
			region,
			out,
			sourceVintage: acquired.sourceVintage,
			buildCmd,
			buildSHA,
			createdAt: new Date().toISOString(),
			indexResolution,
			coverageResolution,
			...(options.chunkSize ? { chunkSize: Number(options.chunkSize) } : {}),
			onProgress: (message) => console.error(`  [soil] ${message}`),
		})

		const lines = [
			`soil.db: ${out} (${artifactSizeMB(out)} MB)`,
			`${result.surveyAreas} survey area(s) · ${result.delineations.toLocaleString()} delineations · ` +
				`${result.mapUnits.toLocaleString()} map units · ${result.components.toLocaleString()} components`,
			`index: ${result.wholeCellRows.toLocaleString()} whole (compacted) · ${result.partialCellRows.toLocaleString()} partial ` +
				`(${(result.storedPartialShare * 100).toFixed(1)}% of stored rows) · resolutions ${result.storedResolutions.join("/")} ` +
				`· ${result.coarsenedFeatures.toLocaleString()} delineation(s) coarsened`,
			`reduction: ${result.capabilityCells.toLocaleString()} cells · ${result.sampledCells.toLocaleString()} sampled by lattice · ` +
				`${result.meanDelineationsPerCell.toFixed(2)} delineations/cell · ` +
				`${result.topClassUnderHalfCells.toLocaleString()} cells whose top class holds under half ` +
				`(${(result.topClassUnderHalfShare * 100).toFixed(1)}%) · ${result.classlessCells.toLocaleString()} with no class at all ` +
				`· ${result.unsampledCells.toLocaleString()} touched cells no lattice point landed inside`,
			`coverage: ${result.coverageCells.toLocaleString()} cells at res ${result.coverageResolution} · ` +
				`${result.coverageCellsWithoutMapping.toLocaleString()} interior cells with no mapped soil, which get NO row`,
			`area: authority ${result.area.publishedKM2.toFixed(1)} km² · rings with holes ${result.area.nestedKM2.toFixed(1)} km² ` +
				`(${(result.area.relativeGap * 100).toFixed(3)}% apart) · rings without holes ${result.area.allExteriorKM2.toFixed(1)} km²`,
			`manifest: name=${soilLayerName(region)} tier=shipped license=${SSURGO_LICENSE} ` +
				`attribution="${SSURGO_ATTRIBUTION}" sourceVintage=${acquired.sourceVintage} buildSHA=${buildSHA}`,
		]

		if (options.verify) {
			lines.push(
				...(await runVerification(out, client, options.verifyPoints ? Number(options.verifyPoints) : undefined))
			)
		}

		return lines
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

export default GazetteerBuildSoil
