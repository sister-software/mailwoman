/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build zoning` — acquire Ireland's Generalised Zoning Types and build the sealed
 *   `zoning-ireland.db` layer. Thin wiring only: item read → download → build → verify all live in
 *   `@mailwoman/zoning/sdk`, so each stays unit-testable without Ink or the network in the loop. Mirrors
 *   `coastal.tsx`'s progress (stderr) / summary (stdout) split.
 *
 *   THE ARTIFACT IS BUILT LOCALLY AND NEVER SHIPPED. Three published statements disagree about the source's
 *   licence, so the manifest carries `tier: build-local` and `license: NOASSERTION`, and the SDK refuses a
 *   `shipped` tier while that holds. This command is how a user gets the layer at all.
 *
 *   `--measure-resolutions` DOES NOT BUILD. The index resolution is a measurement this layer takes rather
 *   than a number argued to, and running the measurement is a mode of its own because it costs a full pass
 *   per candidate and produces a table, not an artifact. What it reports is NOT the `partial` share: 95.7% of
 *   these polygons are smaller than a res-9 cell, so that statistic sits near 100% everywhere. The two
 *   columns that decide are candidates-per-cell and the count of features a centre-in-polygon polyfill would
 *   have returned nothing for.
 *
 *   `--authority` IS THE SMOKE RUNG, and `--limit` narrows it further. Building one local authority over the
 *   real export exercises the field names, the ring-role resolution, the vocabulary census, the projection
 *   and the seal — which is what fixtures structurally cannot.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	formatLayerVerification,
	type ParsedCommandComponent,
	splitNumberList,
	useCommandTask,
} from "#cli-kit"
import { buildSHA as resolveBuildSHA } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Coverage resolution. Res 6 matches what the POI, flood, soil and coastal pipelines write, so a reader already keyed
 * to another layer's coverage cells finds these without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * Index resolution, chosen from the candidates-per-cell and zero-cell measurement — see the workspace README for the
 * table and the reasoning. `--measure-resolutions` re-derives it.
 */
const DEFAULT_INDEX_RESOLUTION = "10"

/**
 * Native command-line contract consumed by the filesystem command router.
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

interface Options {
	export?: string
	out?: string
	indexResolution: string
	coverageResolution: string
	measureResolutions?: string
	authority?: string
	limit?: string
	offline: boolean
	sourceVintage?: string
	chunkSize?: string
	verify: boolean
}

const GazetteerBuildZoning: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const [
			{ dataRootPath },
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
			import("@mailwoman/core/utils"),
			import("@mailwoman/zoning/sdk"),
			import("@mailwoman/zoning/vocabulary"),
		])

		if (options.offline && !options.export) {
			throw new Error(
				"gazetteer build zoning: --offline needs --export, because the archive cannot be acquired offline"
			)
		}

		const client = createGZTClient()

		// The item read supplies the product vintage AND the licence text the build reconciles against. Both are read
		// rather than trusted from a constant: the vintage stamps the manifest, and the Tailte Éireann clause is the reason
		// this layer is built locally rather than shipped.
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
			// THE VINTAGE IS REQUIRED HERE AND NOT EARLIER. It keys the download cache and it stamps the manifest, so a run
			// that neither downloads nor builds — `--measure-resolutions` over an export already on disk — needs none, and
			// demanding one would make the measurement impossible offline.
			if (!vintage) {
				throw new Error(
					"gazetteer build zoning: no product vintage — pass --source-vintage, or drop --offline so the item can be read. " +
						"A downloaded export is cached under its vintage, so one guessed would overwrite another edition in place."
				)
			}

			// The result URL is READ from the Hub job rather than assembled: it carries a generated file id with no
			// relationship to the item id, so a hard-coded URL survives a republish by pointing at a file that is no longer
			// the product. It 302s, and the transfer follows.
			exportPath = await downloadZoningExport({
				url: await client.readExportURL(),
				vintage,
				cacheRoot: String(dataRootPath("zoning", "cache")),
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

		// A BUILD needs the vintage, because it stamps the manifest. A manifest carrying a guessed version carries a number
		// that means nothing.
		if (!vintage) {
			throw new Error(
				"gazetteer build zoning: no product vintage — pass --source-vintage, or drop --offline so the item can be read. " +
					"A manifest stamped with a guessed version carries a number that means nothing."
			)
		}

		const sourceVintage = vintage
		const coverageResolution = Number(options.coverageResolution)
		const indexResolution = Number(options.indexResolution)
		const out = options.out ?? String(dataRootPath("zoning", "zoning-ireland.db"))
		const buildSHA = resolveBuildSHA(String(repoRootPath()))

		// A narrowed run reads a SUBSET on purpose, so its declared count is the subset's own and the build asserts the sum
		// against that rather than against the whole product.
		const narrowed = Boolean(options.authority || options.limit)

		const narrowing = {
			exportPath,
			...(options.authority ? { authorityCode: options.authority } : {}),
			...(options.limit ? { limit: Number(options.limit) } : {}),
		}

		// A NARROWED RUN COUNTS ITSELF FIRST. `ogrinfo` reports the layer's total and nothing narrower, so a build whose
		// declared count was the whole product's would refuse every smoke run — and the declared-count check is the thing
		// that turns a truncated read into a failure rather than into a smaller country. Counting is one extra pass over a
		// file the build reads anyway.
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

		// The live service's own feature count and `Shape__Area` sum are the two-path checks, and the second is the one
		// that catches a hole-orientation mistake: read with their holes the rings total 5,444.5 km², read without them
		// 5,666.6 km². The publisher's figure is not in the archive at all, which is what makes it a second path. A
		// narrowed run reads a subset on purpose, so both checks are skipped there rather than made to pass.
		const serviceChecks =
			options.offline || narrowed
				? {}
				: {
						expectedFeatureCount: (await client.readServiceIdentity()).featureCount,
						expectedSourceAreaM2: await client.readShapeAreaSum(),
					}

		const result = await buildZoningDatabase({
			// A narrowed run is the smoke rung and reads a subset in one process; a full build is BATCHED, one child process
			// per range of the authority's own feature ids. The reason is reproducibility rather than speed — see
			// `@mailwoman/zoning/sdk/ingest-chunk`.
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
					`  [zoning] ${pair.authorityCode} ${JSON.stringify(pair.localCode)} → ${pair.crosswalkCodes.length} generic types (${pair.crosswalkCodes.join(", ")})`
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
