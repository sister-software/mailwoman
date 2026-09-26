/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build soil` — acquire NRCS's SSURGO survey areas for a region and build the
 *   sealed `soil.db` layer. Thin wiring only: the catalogue read, the downloads, the metadata, the build
 *   and the verification all live in `@mailwoman/soil/sdk`.
 *
 *   `--region` names a survey-area prefix, which is the authority's own unit, so `--region IA` builds
 *   every Iowa survey area and `--area IA153` builds one; the manifest's declared extent and the coverage
 *   rows then describe the same set of published survey areas rather than "the United States".
 *
 *   `--measure-resolutions` does not build — the index resolution is a measurement this layer takes rather
 *   than a number argued to.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"

import {
	type CommandSpec,
	CommandTaskResult,
	formatLayerVerification,
	type CommandComponent,
	splitNumberList,
	useCommandTask,
} from "#cli-kit"
import { buildSHA as resolveBuildSHA } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Res 6 matches what the POI and flood layers write, so a reader already keyed to another
 * layer's coverage cells finds these without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * Index resolution, chosen from the measurement table in the workspace readme;
 * `--measure-resolutions` re-derives it.
 */
const DEFAULT_INDEX_RESOLUTION = "9"

/**
 * Native command-line interface consumed by the filesystem command router.
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

/**
 * Shared by the tail of a build and `--verify-only`, so both modes produce the same summary lines.
 */
async function runVerification(
	database: PathBuilder,
	client: Parameters<typeof import("@mailwoman/soil/sdk").verifySoilDatabase>[0]["client"],
	count?: number
): Promise<string[]> {
	const { sampleAgreementPoints, verifySoilDatabase } = await import("@mailwoman/soil/sdk")
	const databasePath = database.toString()

	const points = sampleAgreementPoints(databasePath, count === undefined ? {} : { count })

	const verified = await verifySoilDatabase({
		databasePath,
		client,
		points,
		onProgress: (message) => console.error(`  [verify] ${message}`),
	})

	return formatLayerVerification(verified, {
		serviceLabel: "Soil Data Access",
		outsideLabel: "outside the built survey areas",
		outsideNoneLabel: "none read a map unit",
		describeRow: (row) =>
			`  [verify] disagree at ${row.latitude}, ${row.longitude} (${row.label}): artifact ${row.localMukey ?? "no map unit"}, ` +
			`service ${row.serviceMukey ?? "no map unit"}, ${row.nearestEdgeMetres?.toFixed(3) ?? "?"} m to the nearest edge`,
	})
}

const GazetteerBuildSoil: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { soilDatabasePath } = await import("@mailwoman/soil/paths")

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

		// `--verify-only` checks an existing artifact because a full-region build takes hours,
		// so re-running the check must not cost a rebuild.
		if (options.verifyOnly) {
			return runVerification(
				PathBuilder.from(options.out ?? soilDatabasePath("soil.db")),
				client,
				options.verifyPoints ? Number(options.verifyPoints) : undefined
			)
		}

		const acquired = await acquireRegion({
			client,
			prefix,
			cacheRoot: soilDatabasePath("cache", "archives"),
			onProgress: (message) => console.error(`  [acquire] ${message}`),
		})

		console.error(`▸ product vintage: ${acquired.sourceVintage} (${acquired.areas.length} survey area(s))`)

		if (options.measureResolutions) {
			const resolutions = splitNumberList(options.measureResolutions)
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
		const out = PathBuilder.from(options.out ?? soilDatabasePath("soil.db"))
		const buildSHA = resolveBuildSHA(repoRootPath())

		const buildCmd =
			`mailwoman gazetteer build soil ${options.area ? `--area ${options.area}` : `--region ${prefix}`} ` +
			`--index-resolution ${indexResolution} --coverage-resolution ${coverageResolution}`

		const result = await buildSoilDatabase({
			areas: acquired.areas,
			region,
			out: out.toString(),
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
			`soil.db: ${out} (${await formatFileSize(out)})`,
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
			`area: authority ${result.area.witness === "source" ? `${result.area.sourceKM2.toFixed(1)} km²` : "not published (no witness)"} · ` +
				`rings with holes ${result.area.nestedKM2.toFixed(1)} km²` +
				`${result.area.witness === "source" ? ` (${(result.area.relativeGap * 100).toFixed(3)}% apart)` : ""} · ` +
				`rings without holes ${result.area.allExteriorKM2.toFixed(1)} km²`,
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

export default GazetteerBuildSoil
