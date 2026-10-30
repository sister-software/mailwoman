/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The OpenStreetMap build recipe run through the installer against a small local PBF and a local registry.
 *
 *   One regional PBF holds a German, a Dutch and a Belgian address. A build of Germany and the Netherlands
 *   acquires the PBF once, clips each country to its outline, records the policy, the outline digest and the
 *   counts in each output's derivation, installs both, and activates them after any source the country
 *   already selects. A repeated build transfers no bytes and reuses the extraction.
 */

import { APIClient } from "@mailwoman/core/api"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { md5Hex, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { type AcquiredBuildInput, type BuildRecipe, BuildRecipeName, ServingRole } from "@mailwoman/core/layers"
import { createOSMAddressPointsRecipe } from "@mailwoman/osm/tools/address-points-recipe"
import { writePBF } from "@mailwoman/osm/tools/pbf-writer"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { availableBuildEntry, buildIdentity, BuildRefusedError, executeBuild, planBuild } from "#data/build"
import { LayerCatalog, readActiveSelection, replaceActiveSelection } from "#data/catalog"
import { AvailabilityKind, availableDataEntryProblems } from "#data/registry"
import { openOSMRegionDatabases } from "#geocode/osm-layers"
import { FixtureRegistry, installFixtureArtifact } from "#test-kit/fixture-registry"

const PBF = writePBF([
	{
		id: 1,
		lat: 52.5163,
		lon: 13.3807,
		tags: { "addr:housenumber": "77", "addr:street": "Unter den Linden", "addr:postcode": "10117" },
	},
	{
		id: 2,
		lat: 52.5076,
		lon: 13.3904,
		tags: { "addr:housenumber": "43", "addr:street": "Friedrichstraße", "addr:postcode": "10117" },
	},
	{
		id: 3,
		lat: 52.3731,
		lon: 4.8926,
		tags: { "addr:housenumber": "1", "addr:street": "Dam", "addr:postcode": "1012JS" },
	},
	{
		id: 4,
		lat: 50.8467,
		lon: 4.3525,
		tags: { "addr:housenumber": "1", "addr:street": "Grand-Place", "addr:postcode": "1000" },
	},
])

/**
 * A square outline around a point, as a geoBoundaries ADM0 file holds one feature.
 */
function outline(lon: number, lat: number, half: number): Buffer {
	const ring = [
		[lon - half, lat - half],
		[lon + half, lat - half],
		[lon + half, lat + half],
		[lon - half, lat + half],
		[lon - half, lat - half],
	]

	return Buffer.from(
		stringifyJSON({
			type: "FeatureCollection",
			features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
		})
	)
}

const REGION = { id: "fixture/de-nl", countries: ["DE", "NL"], partial: [] }
const DE_OUTLINE = outline(13.38, 52.51, 0.5)
const NL_OUTLINE = outline(4.89, 52.37, 0.5)

let scratch: TemporaryDirectory
let registry: FixtureRegistry
let client: APIClient
let recipe: BuildRecipe

beforeEach(async () => {
	scratch = await temporaryDirectory("mw-data-build-")
	registry = await new FixtureRegistry().start()
	registry.put("geofabrik/fixture/de-nl-latest.osm.pbf", PBF)
	registry.put("geofabrik/fixture/de-nl-latest.osm.pbf.md5", Buffer.from(`${md5Hex(PBF)}  de-nl-latest.osm.pbf\n`))

	for (const [iso3, body] of [
		["DEU", DE_OUTLINE],
		["NLD", NL_OUTLINE],
	] as const) {
		registry.put(
			`geoboundaries/api/current/gbOpen/${iso3}/ADM0/`,
			Buffer.from(stringifyJSON({ gjDownloadURL: `${registry.baseURL}outlines/${iso3}-ADM0.geojson` }))
		)

		registry.put(`outlines/${iso3}-ADM0.geojson`, body)
	}

	client = new APIClient({ displayName: "fixture", retry: false })

	recipe = createOSMAddressPointsRecipe({
		geofabrikBaseURL: `${registry.baseURL}geofabrik/`,
		geoBoundariesBaseURL: `${registry.baseURL}geoboundaries/`,
		regions: [REGION],
	})
})

afterEach(async () => {
	await client[Symbol.asyncDispose]()
	await registry[Symbol.asyncDispose]()
	await scratch[Symbol.asyncDispose]()
})

const REQUEST = { countries: ["DE", "NL"], region: REGION.id }

describe("data build osm-address-points", () => {
	it("plans one regional input and one outline per clipped country, without a request or a write", async () => {
		const report = await planBuild(scratch.path("root"), recipe, REQUEST)

		expect(report.problems).toEqual([])

		expect(report.inputs.map((planned) => planned.input.key)).toEqual([
			"geofabrik:fixture/de-nl",
			"geoboundaries:DEU",
			"geoboundaries:NLD",
		])

		expect(report.plan.outputs.map((output) => [output.country, output.inputs])).toEqual([
			["DE", ["geofabrik:fixture/de-nl", "geoboundaries:DEU"]],
			["NL", ["geofabrik:fixture/de-nl", "geoboundaries:NLD"]],
		])

		expect(registry.requests).toEqual([])
	})

	it("acquires the region once, records each country's derivation, installs and activates both", async () => {
		const root = scratch.path("root")
		const report = await planBuild(root, recipe, REQUEST)
		const result = await executeBuild(report, recipe, { client, builderSHA: "fixture", activate: true })

		// One transfer of the regional file serves both countries.
		expect(
			registry.requests.filter((request) => request === "GET geofabrik/fixture/de-nl-latest.osm.pbf")
		).toHaveLength(1)

		const pbfSHA = sha256Hex(PBF)
		const [de, nl] = result.outputs

		for (const built of [de!, nl!]) {
			expect(built.manifest.recipe).toBe(BuildRecipeName.OSMAddressPoints)
			expect(built.manifest.sources[0]).toMatchObject({ publisher: "Geofabrik", sha256: pbfSHA })
		}

		expect(de!.manifest.derivation).toEqual({
			policy: { name: "osm/de/extraction-policy", version: 1 },
			clipping: { description: "geoBoundaries gbOpen ADM0 DEU", sha256: sha256Hex(DE_OUTLINE) },
			filter: expect.stringContaining("addr:housenumber"),
			counts: expect.objectContaining({ total: 4, written: 2, outside: 2 }),
		})

		expect(nl!.manifest.derivation).toMatchObject({
			clipping: { sha256: sha256Hex(NL_OUTLINE) },
			counts: { total: 4, written: 1, outside: 3 },
		})

		expect(result.activatedGeneration).toBe(1)

		expect(result.installation.origin).toEqual({
			kind: "built",
			recipe: BuildRecipeName.OSMAddressPoints,
			buildID: result.buildID,
		})

		using provider = (await openOSMRegionDatabases(root))!

		expect(
			provider
				.for("de")
				.addressPoints?.find({ street: "Unter den Linden", number: "77", postcode: "10117", bbox: null })
		).toMatchObject({ lat: 52.5163, source: "openstreetmap:de" })

		expect(
			provider.for("nl").addressPoints?.find({ street: "Dam", number: "1", postcode: "1012JS", bbox: null })
		).toMatchObject({
			lat: 52.3731,
		})

		// The Belgian point lies outside both outlines and was written to neither.
		expect(
			provider.for("de").addressPoints?.find({ street: "Grand-Place", number: "1", postcode: "1000", bbox: null }) ??
				null
		).toBeNull()
	})

	it("transfers no bytes and reuses the extraction when nothing changed", async () => {
		const root = scratch.path("root")

		const first = await executeBuild(await planBuild(root, recipe, REQUEST), recipe, {
			client,
			builderSHA: "fixture",
			activate: false,
		})

		registry.requests.length = 0

		const second = await executeBuild(await planBuild(root, recipe, REQUEST), recipe, {
			client,
			builderSHA: "fixture",
			activate: false,
		})

		// Only the identity reads repeat: each file's head, the PBF's `.md5` sidecar and the outlines' metadata.
		expect(
			registry.requests.filter(
				(request) => request.startsWith("GET") && !request.endsWith(".md5") && !request.includes("gbOpen")
			)
		).toEqual([])

		expect(second.inputs.every((input) => input.reused)).toBe(true)
		expect(second.buildID).toBe(first.buildID)
		expect(second.outputs.every((output) => output.reused)).toBe(true)
		expect(second.installation.id).toBe(first.installation.id)
	})

	it("builds again under a changed policy version instead of reusing the earlier extraction", async () => {
		const report = await planBuild(scratch.path("root"), recipe, REQUEST)

		const inputs = new Map<string, AcquiredBuildInput>(
			report.plan.inputs.map((input) => [
				input.key,
				{ input, path: input.fileName, sha256: "a".repeat(64), md5: null, release: null, url: input.url },
			])
		)

		const before = buildIdentity(report.plan, inputs, "fixture")

		const bumped = {
			...report.plan,
			outputs: report.plan.outputs.map((output) => ({ ...output, policy: { ...output.policy, version: 2 } })),
		}

		expect(buildIdentity(bumped, inputs, "fixture")).not.toBe(before)
	})

	it("activates a build after the national source its country already selects", async () => {
		const root = scratch.path("root")

		const national = await installFixtureArtifact(
			root,
			ServingRole.AddressPoints,
			"address-points-nl.db",
			"national bytes",
			{
				scope: { countries: ["NL"], subdivisions: null },
				entryScope: { country: "NL", subdivision: null },
				locale: "nl",
			}
		)

		await replaceActiveSelection(root, { basedOn: null, set: [national.entry] })

		const result = await executeBuild(await planBuild(root, recipe, { countries: ["NL"], region: REGION.id }), recipe, {
			client,
			builderSHA: "fixture",
			activate: true,
		})

		const entry = (await readActiveSelection(root))?.entries.find((candidate) => candidate.scope.country === "NL")

		expect(entry?.order).toEqual([
			...national.entry.order,
			{ installationID: result.installation.id, artifactID: result.outputs[0]!.manifest.id },
		])

		// The OpenStreetMap tier reads the build, and the national tier keeps its own source.
		const catalog = await LayerCatalog.read(root)

		await expect(catalog.firstPath(ServingRole.AddressPoints, { country: "NL", subdivision: null })).resolves.toBe(
			national.path
		)
	})

	it("refuses before any transfer when a prerequisite is missing", async () => {
		const missing: BuildRecipe = {
			...recipe,
			prerequisites: async () => [{ name: "ogr2ogr", satisfied: false, detail: "not on PATH" }],
		}

		const report = await planBuild(scratch.path("root"), missing, REQUEST)

		await expect(
			executeBuild(report, missing, { client, builderSHA: "fixture", activate: false })
		).rejects.toBeInstanceOf(BuildRefusedError)

		expect(registry.requests).toEqual([])
	})

	it("registers the recipe as a build entry of the available-data registry", () => {
		const entry = availableBuildEntry(createOSMAddressPointsRecipe())

		expect(availableDataEntryProblems(entry)).toEqual([])

		expect(entry).toMatchObject({
			name: BuildRecipeName.OSMAddressPoints,
			kind: AvailabilityKind.Build,
			capabilities: [ServingRole.AddressPoints],
			license: "ODbL-1.0",
			artifacts: [],
		})

		expect(entry.countries).toEqual(expect.arrayContaining(["DE", "FR", "GB", "NL", "NZ"]))
	})

	it("reports a country with no policy and a region that does not hold the country", async () => {
		const report = await planBuild(scratch.path("root"), recipe, { countries: ["AT", "FR"], region: REGION.id })

		expect(report.problems.map((problem) => problem.detail)).toEqual([
			expect.stringContaining("AT has no OpenStreetMap extraction policy"),
			expect.stringContaining("region fixture/de-nl does not hold FR"),
		])
	})
})
