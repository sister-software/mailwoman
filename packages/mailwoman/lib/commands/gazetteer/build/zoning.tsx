/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build zoning` — acquire Ireland's Generalised Zoning Types and build the sealed
 *   `zoning-ireland.db` layer. Thin wiring only: item read → download → build → verify all live in
 *   `@mailwoman/zoning/sdk`.
 *
 *   The artifact is built locally and never shipped: three published statements disagree about the source's
 *   licence, so the manifest carries `tier: build-local` and `license: noassertion`, and the SDK refuses a
 *   `shipped` tier while that holds.
 *
 *   `--measure-resolutions` does not build — the index resolution is a measurement this layer takes rather
 *   than a number argued to.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { Box, Text } from "ink"

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
 * Res 6 matches what the POI, flood, soil and coastal pipelines write, so a reader already keyed
 * to another layer's coverage cells finds these without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * Index resolution, chosen from the candidates-per-cell and zero-cell measurement in
 * the workspace readme; `--measure-resolutions` re-derives it.
 */
const DEFAULT_INDEX_RESOLUTION = "10"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "zoning",
	description: "Build the Irish Generalised Zoning Types layer (build-local)",
	options: {
		export: { type: "string", description: "Bulk GeoJSON export path; downloaded when absent" },
		out: { type: "string", description: "zoning-ireland.db output path" },
		"index-resolution": { type: "string", default: DEFAULT_INDEX_RESOLUTION, description: "H3 index resolution" },
		"coverage-resolution": {
			type: "string",
			default: DEFAULT_COVERAGE_RESOLUTION,
			description: "H3 coverage resolution",
		},
		"measure-resolutions": {
			type: "string",
			description: "Measure candidates-per-cell and the zero-cell count at these resolutions and stop",
		},
		authority: { type: "string", description: "Build one local authority's own LA_CODE (the smoke rung)" },
		limit: { type: "string", description: "Stop the ingest after N features (the smoke rung)" },
		offline: { type: "boolean", default: false, description: "Skip every network read; --export required" },
		"source-vintage": { type: "string", description: "Product vintage; read from the item when absent" },
		"chunk-size": { type: "string", description: "Feature ids per ingest process (default 100000)" },
		verify: { type: "boolean", default: false, description: "Run the two-path agreement check after building" },
	},
} as const satisfies CommandSpec

const GazetteerBuildZoning: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const [
			{ zoningDatabasePath },
			{
				assertAttributionUnchanged,
				buildZoningDatabase,
				createExportFeatureSource,
				createGZTClient,
				createServiceReader,
				downloadZoningExport,
				formatResolutionRows,
				measureZoningCellResolutions,
				sampleAgreementPoints,
				verifyZoningDatabase,
			},
			{ GZT_LICENSE_CONTRADICTION },
		] = await Promise.all([
			import("@mailwoman/zoning/paths"),
			import("@mailwoman/zoning/sdk"),
			import("@mailwoman/zoning/vocabulary"),
		])

		if (options.offline && !options.export) {
			throw new Error(
				"gazetteer build zoning: --offline needs --export, because the archive cannot be acquired offline"
			)
		}

		const client = createGZTClient()

		// The item read supplies the product vintage and the licence text the build
		// reconciles against, both read rather than trusted from a constant.
		const item = options.offline ? undefined : await client.readItemRecord()
		const vintage = options.sourceVintage ?? item?.modifiedDate

		if (vintage) {
			console.error(`▸ product vintage: ${vintage}`)
		}

		if (item) {
			assertAttributionUnchanged(item)
		}

		let exportPath = options.export

		if (!exportPath) {
			// The vintage is required here and not earlier because it keys the download cache
			// and stamps the manifest; demanding one earlier would make an offline
			// measurement over an on-disk export impossible.
			if (!vintage) {
				throw new Error(
					"gazetteer build zoning: no product vintage — pass --source-vintage, or drop --offline so the item can be read. " +
						"A downloaded export is cached under its vintage, so one guessed would overwrite another edition in place."
				)
			}

			// The export URL is read from the Hub job rather than assembled from the item id, because
			// a hard-coded URL would survive a republish pointing at a file that is no longer the product.
			exportPath = await downloadZoningExport({
				url: await client.readExportURL(),
				vintage,
				cacheRoot: zoningDatabasePath("cache"),
				onProgress: (message) => console.error(`  [download] ${message}`),
			})
		}

		if (options.measureResolutions) {
			const report = await measureZoningCellResolutions({
				exportPath,
				resolutions: splitNumberList(options.measureResolutions),
				...(options.authority ? { authorityCode: options.authority } : {}),
				...(options.limit ? { limit: Number(options.limit) } : {}),
				onProgress: (message) => console.error(`  [measure] ${message}`),
			})

			return [
				`measured ${report.features.toLocaleString()} of ${report.declaredFeatureCount.toLocaleString()} features`,
				...formatResolutionRows(report.measurements),
			]
		}

		// A build needs the vintage because it stamps the manifest, and a manifest
		// carrying a guessed version states no fact.
		if (!vintage) {
			throw new Error(
				"gazetteer build zoning: no product vintage — pass --source-vintage, or drop --offline so the item can be read. " +
					"A manifest stamped with a guessed version carries a number that means nothing."
			)
		}

		const sourceVintage = vintage
		const coverageResolution = Number(options.coverageResolution)
		const indexResolution = Number(options.indexResolution)
		const out = options.out ?? zoningDatabasePath("zoning-ireland.db").toString()
		const buildSHA = resolveBuildSHA(repoRootPath())

		// A narrowed run reads a subset on purpose, so its declared count is the subset's own
		// and the build asserts against that rather than the whole product.
		const narrowed = Boolean(options.authority || options.limit)

		const narrowing = {
			exportPath,
			...(options.authority ? { authorityCode: options.authority } : {}),
			...(options.limit ? { limit: Number(options.limit) } : {}),
		}

		// `ogrinfo` reports only the layer's total, so a narrowed run counts its own subset first —
		// otherwise the declared-count check, which turns a truncated read into a failure
		// rather than a smaller country, would refuse every smoke run.
		let narrowedCount = 0

		if (narrowed) {
			const { readZoningFeatures } = await import("@mailwoman/zoning/sdk/ingest")

			for await (const _feature of readZoningFeatures(narrowing)) {
				narrowedCount++
			}
		}

		const source = await createExportFeatureSource({
			...narrowing,
			...(narrowed ? { declaredFeatureCount: narrowedCount } : {}),
		})

		console.error(`▸ source declares ${source.declaredFeatureCount.toLocaleString()} features`)

		// The live service's own feature count and `Shape__Area` sum are the two-path checks —
		// the publisher's figure is absent from the archive, which is what makes it a second
		// path — and a narrowed run skips both rather than making them pass.
		const serviceChecks =
			options.offline || narrowed
				? {}
				: {
						expectedFeatureCount: (await client.readServiceIdentity()).featureCount,
						expectedSourceAreaM2: await client.readShapeAreaSum(),
					}

		const result = await buildZoningDatabase({
			// A narrowed run reads its subset in one process; a full build is batched one child
			// process per range of feature ids, for reproducibility rather than speed.
			...(narrowed
				? { source }
				: {
						batched: {
							exportPath,
							declaredFeatureCount: source.declaredFeatureCount,
							...(options.chunkSize ? { chunkSize: Number(options.chunkSize) } : {}),
						},
					}),
			out,
			sourceVintage,
			buildCmd: `mailwoman gazetteer build zoning --index-resolution ${indexResolution} --coverage-resolution ${coverageResolution}`,
			buildSHA,
			createdAt: new Date().toISOString(),
			indexResolution,
			coverageResolution,
			...serviceChecks,
			onProgress: (message) => console.error(`  [zoning] ${message}`),
		})

		const lines = [
			`zoning-ireland.db: ${out} (${await formatFileSize(out)})`,
			`${result.features.toLocaleString()} zoning polygons across ${result.jurisdictions} local authorities and ${result.plans} plans`,
			`rings: ${result.rings.total.toLocaleString()} total · ${result.rings.exteriors.toLocaleString()} exterior (clockwise) · ` +
				`${result.rings.holes.toLocaleString()} hole (counter-clockwise) · ${result.rings.exteriorByMagnitude.toLocaleString()} exterior(s) chosen by magnitude · ` +
				`${result.rings.nestedHoles.toLocaleString()} hole(s) placed inside a parent · ` +
				`${result.rings.adjacentHoles.toLocaleString()} on a parent's boundary`,
			`cells: ${result.wholeCellRows.toLocaleString()} whole (compacted per feature) · ${result.partialCellRows.toLocaleString()} partial ` +
				`(${(result.storedPartialShare * 100).toFixed(1)}% of stored rows) · resolutions ${result.storedResolutions.join("/")} · ` +
				`${result.coarsenedFeatures.toLocaleString()} feature(s) coarsened`,
			`coverage: ${result.coverageCells.toLocaleString()} cells at res ${result.coverageResolution}, basis ${result.coverageBasis} — ` +
				"presence only, and NO negative claim: an absent polygon may be outside any plan area, unzoned land inside one, or a jurisdiction nobody has published",
			`area: publisher ${
				result.area.witness === "source"
					? `${result.area.sourceKM2.toFixed(1)} km²`
					: "not read (narrowed or offline run)"
			} · rings with holes ${result.area.nestedKM2.toFixed(1)} km²` +
				`${result.area.witness === "source" ? ` (${(result.area.relativeGap * 100).toFixed(3)}% apart)` : ""}` +
				` · rings without holes ${result.area.allExteriorKM2.toFixed(1)} km²`,
			`vocabulary: ${result.vocabulary
				.map(
					(census) =>
						`${census.scheme} ${census.codes}${census.undeclared ? ` (${census.undeclared} undeclared: ${census.undeclaredCodes.join(", ")})` : ""}`
				)
				.join(" · ")}`,
			`crosswalk: ${result.crosswalk.pairs.toLocaleString()} (authority, local code) pairs, ${result.crosswalk.nonFunctionalPairs} of them taking more than one generic type — ` +
				"which is why zoning_crosswalk_edge is empty and the mapping stays per polygon",
			`manifest: name=zoning-ie-gzt tier=${result.tier} license=${result.license} sourceVintage=${sourceVintage} buildSHA=${buildSHA}`,
			`licence: ${GZT_LICENSE_CONTRADICTION}`,
		]

		if (result.crosswalk.worst.length) {
			for (const pair of result.crosswalk.worst) {
				console.error(
					`  [zoning] ${pair.authorityCode} ${stringifyJSON(pair.localCode)} → ${pair.crosswalkCodes.length} generic types (${pair.crosswalkCodes.join(", ")})`
				)
			}
		}

		if (options.verify && !options.offline) {
			const points = sampleAgreementPoints(out)

			const verified = await verifyZoningDatabase({
				databasePath: out,
				readServiceFeatures: createServiceReader(client),
				points,
				onProgress: (message) => console.error(`  [verify] ${message}`),
			})

			lines.push(
				...formatLayerVerification(verified, {
					serviceLabel: "the live service",
					outsideLabel: "outside the publication",
					extraSummary: `${verified.codeMismatches} local-code mismatch(es)`,
					describeRow: (row) =>
						`  [verify] disagree at ${row.latitude}, ${row.longitude} (${row.label}): artifact ${row.local.kind}, ` +
						`service ${row.serviceInside ? "inside" : "outside"}, ` +
						`${row.nearestEdgeMetres === undefined ? "no nearby polygon" : `${row.nearestEdgeMetres.toFixed(3)} m to nearest edge`}`,
				})
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

export default GazetteerBuildZoning
