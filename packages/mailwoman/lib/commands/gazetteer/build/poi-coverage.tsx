/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build poi-coverage` — build a POI layer whose `layer_coverage` rows carry an
 *   EXCLUSION-GRADE basis: one class, one named administrative region, completeness measured rather than
 *   asserted (#1964).
 *
 *   Everything else in this pipeline writes `basis: source_present`, which supports presence and nothing
 *   else. This command is the one path to `basis: surveyed`, and what it costs to take it is a second,
 *   independent inventory of the same class in the same region: it extracts the class from a Geofabrik
 *   `.osm.pbf`, reads the same class out of an already-sealed reference layer, matches the two under a
 *   pre-registered protocol grid, and records the weakest completeness the grid supports.
 *
 *   It is a MEASURING INSTRUMENT, and parameterized so the claim it makes can be re-run and audited — not
 *   so coverage can be widened by running it more places. A completeness estimate from two sources bounds
 *   sampling error only; it cannot see the dependence between the two sources, which pushes completeness up
 *   and is the direction that turns a data gap into confident negative evidence. Breadth waits on a basis
 *   that survives review, per `docs/superpowers/specs/2026-08-27-exclusion-grade-coverage-pilot.md`.
 *
 *   Tier is `build-local`, always: the subject inventory is OSM, so the built artifact is a Derived Database
 *   under ODbL and we ship the builder rather than the bytes — the same posture as `--source osm` on
 *   `gazetteer build poi`.
 */

import { formatFileSize } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { stripCombiningMarks } from "@mailwoman/normalize"
import { H3_MAX_RESOLUTION } from "@mailwoman/spatial"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import type { POISourceRow } from "#gazetteer-pipeline/poi/build-poi"
import { buildSHA as resolveBuildSHA } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Coverage resolution. Res 6 matches what the rest of the POI pipeline writes, so a reader already keyed to poi.db's
 * coverage cells finds these ones without knowing which build produced them.
 */
const DEFAULT_COVERAGE_RESOLUTION = "6"

/**
 * The pilot class. Named in the taxonomy with an `osmTag` of `amenity=pharmacy`, so both inventories are selected by
 * the same declaration rather than by two hand-written predicates.
 */
const DEFAULT_CATEGORY = "pharmacy"

/**
 * `admin_level` of a French région or a German Land. The level a bounded region is usually named at.
 */
const DEFAULT_ADMIN_LEVEL = "4"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "poi-coverage",
	description: "Build a POI layer with measured, exclusion-grade coverage cells",
	options: {
		pbf: { type: "string", description: "OSM PBF extract covering the region" },
		region: { type: "string", description: "Administrative boundary name, matched exactly" },
		"admin-level": { type: "string", default: DEFAULT_ADMIN_LEVEL, description: "Boundary admin_level" },
		category: { type: "string", default: DEFAULT_CATEGORY, description: "POI taxonomy category id" },
		country: { type: "string", description: "ISO country code stamped onto OSM rows" },
		release: { type: "string", description: "OSM extract vintage, e.g. 260627" },
		reference: { type: "string", description: "Sealed reference layer. Default $MAILWOMAN_DATA_ROOT/poi/poi.db" },
		resolution: { type: "string", default: DEFAULT_COVERAGE_RESOLUTION, description: "Coverage H3 resolution" },
		out: { type: "string", description: "Output layer database" },
	},
} as const satisfies CommandSpec

interface Options {
	pbf?: string
	region?: string
	adminLevel: string
	category: string
	country?: string
	release?: string
	reference?: string
	resolution: string
	out?: string
}

/**
 * Filesystem-safe form of a region name, for the default output path.
 */
function slugify(value: string): string {
	return stripCombiningMarks(value)
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-|-$/g, "")
}

const GazetteerBuildPOICoverage: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { pbf, region, country: rawCountry, release } = options

		if (!pbf || !region || !rawCountry || !release) {
			throw new Error(
				"gazetteer build poi-coverage requires --pbf <extract.osm.pbf> --region <name> --country <cc> " +
					"--release <vintage>"
			)
		}

		const { LayerTier } = await import("@mailwoman/core/layers")
		const { dataRootPath } = await import("@mailwoman/core/utils")
		const { getPOICategory } = await import("@mailwoman/poi-taxonomy/lookup")

		const { buildPOIDatabase } = await import("#gazetteer-pipeline/poi/build-poi")
		const { buildExclusionCoverage } = await import("#gazetteer-pipeline/poi/exclusion-coverage")
		const { geometryBBox } = await import("@mailwoman/spatial")
		const { readReferenceInventory } = await import("#gazetteer-pipeline/poi/reference-inventory")

		const category = getPOICategory(options.category)

		if (!category?.osmTag) {
			throw new Error(
				`gazetteer build poi-coverage: taxonomy category ${JSON.stringify(options.category)} ` +
					`${category ? "carries no osmTag, so it cannot be extracted from OSM" : "does not exist"}`
			)
		}

		const country = rawCountry.trim().toUpperCase()
		const resolution = Number.parseInt(options.resolution, 10)

		if (!Number.isInteger(resolution) || resolution < 0 || resolution > H3_MAX_RESOLUTION) {
			throw new Error(`--resolution must be an H3 resolution in [0, 15], got ${JSON.stringify(options.resolution)}`)
		}

		const referencePath = options.reference ?? dataRootPath("poi", "poi.db")
		const out = options.out ?? dataRootPath("poi", `poi-coverage-${options.category}-${slugify(region)}.db`)
		const buildSHA = resolveBuildSHA(String(repoRootPath()))

		// DYNAMIC import, required: @mailwoman/osm is UNPUBLISHED (ODbL counsel sign-off pending —
		// see osm/README.md), so a top-level import breaks the published CLI on a clean install. Same
		// reasoning as the `--source osm` branch of `gazetteer build poi`.
		const { extractOSMBoundary, extractOSMPOIs, tagRuleFromOSMTag } = await import("@mailwoman/osm/sdk")

		console.error(`▸ boundary: ${region} (admin_level=${options.adminLevel}) from ${pbf}`)

		const boundary = await extractOSMBoundary(pbf, { name: region, adminLevel: options.adminLevel })

		console.error(`  relation ${boundary.osmID}`)
		console.error(`▸ subject: OSM ${category.osmTag} from ${pbf}`)

		const rows: POISourceRow[] = []

		for await (const row of extractOSMPOIs(pbf, [tagRuleFromOSMTag(options.category, category.osmTag)])) {
			// extractOSMPOIs yields `country: ""` — a bare OSM feature carries no country property.
			rows.push({ ...row, country })
		}

		console.error(`  ${rows.length.toLocaleString()} features`)
		console.error(`▸ reference: ${options.category} from ${referencePath}`)

		const reference = await readReferenceInventory({
			databasePath: referencePath,
			category: options.category,
			bbox: geometryBBox(boundary.geometry),
		})

		console.error(`  ${reference.rows.length.toLocaleString()} rows`)
		console.error("▸ measure: capture-recapture across the protocol grid")

		const coverage = buildExclusionCoverage({
			geometry: boundary.geometry,
			resolution,
			subject: rows,
			reference: reference.rows,
		})

		for (const p of coverage.completeness.perProtocol) {
			console.error(
				`  [${p.protocol}] m=${p.matched} population=${p.estimate.population.toFixed(1)} ` +
					`completeness=${p.completeness.toFixed(4)} lower=${p.completenessLowerBound.toFixed(4)}`
			)
		}

		console.error(`▸ build: ${out}`)

		const result = await buildPOIDatabase({
			rows,
			out,
			release,
			buildSHA,
			source: "osm",
			tier: LayerTier.BuildLocal,
			coverageCellsOverride: coverage.cells,
			createdAt: new Date().toISOString(),
			onProgress: (phase, message) => console.error(`  [${phase}] ${message}`),
		})

		const { completeness } = coverage

		return [
			`poi coverage layer (${options.category}/${region}): ${out} (${await formatFileSize(out)})`,
			`${result.rows.toLocaleString()} rows · ${result.coverageCells.toLocaleString()} surveyed cells ` +
				`· ${coverage.emptyCells.toLocaleString()} of them observed-empty`,
			`inventories: reference ${completeness.firstCount.toLocaleString()} · subject ${completeness.secondCount.toLocaleString()}` +
				` (outside region: ${coverage.referenceOutsideRegion.toLocaleString()} / ${coverage.subjectOutsideRegion.toLocaleString()})`,
			...completeness.perProtocol.map(
				(p) =>
					`  ${p.protocol}: m=${p.matched} N=${p.estimate.population.toFixed(1)} ` +
					`[${p.estimate.lower.toFixed(1)}, ${p.estimate.upper.toFixed(1)}] ` +
					`completeness=${p.completeness.toFixed(4)} lower=${p.completenessLowerBound.toFixed(4)}`
			),
			`recorded completeness ${completeness.recorded.toFixed(4)} (weakest bound, from "${completeness.recordedFrom}")` +
				` · basis=surveyed`,
			`manifest: name=poi tier=build-local source=osm sourceVintage=${release} buildSHA=${buildSHA}`,
			`boundary: OSM relation ${boundary.osmID} (${region}, admin_level=${options.adminLevel})`,
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

export default GazetteerBuildPOICoverage
