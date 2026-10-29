/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The BAN and POI readers on the active selection, compared with their conventional paths on fixed bytes,
 *   and the overlapping-national, multi-country and FST artifact-set fixtures opened through the catalog.
 *
 *   The same database bytes sit at the conventional path under one data root and in an installed, selected
 *   artifact under another. Every query answers the same under both, so the difference list is empty. Two
 *   French address-point sources in one entry answer from the first readable one, and the second answers only
 *   when the first is absent. One OpenStreetMap artifact scoped to four countries is selected for each of them.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { copyFileTo, makeDirectories, removePath, writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { artifactSetID, ArtifactFormat, type SelectionEntry, ServingRole } from "@mailwoman/core/layers"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	AddressPointSqliteLookup,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import {
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { LayerCatalog, replaceActiveSelection } from "#data/catalog"
import { openBANRegionDatabases } from "#geocode/ban-layers"
import { layerDatabasePath, layerDatabases, resolveLayerDatabasePath } from "#geocode/layer-paths"
import { nationalAddressPointsPath, OvertureNationalDatabaseProvider } from "#geocode/national-overture"
import { installFixtureArtifact } from "#test-kit/fixture-registry"

/**
 * Write an address-point database with one point per row, keyed under `locale`.
 */
async function writePoints(
	path: PathBuilder,
	locale: StreetLocale,
	source: string,
	rows: ReadonlyArray<{ street: string; number: string; postcode: string; locality: string; lat: number; lon: number }>
): Promise<void> {
	using db = new DatabaseClient<AddressPointDatabase>(path)

	await createAddressPointTable(db)

	const insert = db.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

	for (const row of rows) {
		const key = normalizeStreetForKeyLocale(row.street, locale)

		insert.run(
			key,
			key,
			row.number,
			null,
			row.postcode,
			normalizeLocalityForKey(row.locality),
			row.street,
			row.lat,
			row.lon,
			source,
			"r1",
			null,
			null
		)
	}
}

const FR_ROWS = [
	{ street: "Rue de Rivoli", number: "2", postcode: "75001", locality: "Paris", lat: 48.8566, lon: 2.3522 },
	{ street: "Rue de Rivoli", number: "10", postcode: "75004", locality: "Paris", lat: 48.8558, lon: 2.3581 },
	{ street: "Avenue de la République", number: "40", postcode: "75011", locality: "Paris", lat: 48.8656, lon: 2.378 },
]

/**
 * Queries that hit, miss by number, miss by postcode, and scope by locality instead of postcode.
 */
const FR_QUERIES = [
	{ street: "Rue de Rivoli", number: "2", postcode: "75001", bbox: null },
	{ street: "Rue de Rivoli", number: "10", postcode: "75004", bbox: null },
	{ street: "Rue de Rivoli", number: "4", postcode: "75001", bbox: null },
	{ street: "Rue de Rivoli", number: "2", postcode: "75002", bbox: null },
	{ street: "Avenue de la République", number: "40", postcode: "75011", bbox: null },
	{ street: "Avenue de la Republique", number: "40", postcode: "75011", bbox: null },
	{ street: "Rue de Rivoli", number: "2", locality: "Paris", bbox: null },
	{ street: "Rue Inconnue", number: "1", postcode: "75001", bbox: null },
]

let scratch: TemporaryDirectory
let banBytes: Buffer

beforeAll(async () => {
	scratch = await temporaryDirectory("mw-selection-parity-")
	await makeDirectories(scratch.path("fixtures"))
	await writePoints(scratch.path("fixtures", "ban-fr.db"), "fr", "ban:fr", FR_ROWS)
	banBytes = await readLocalBuffer(scratch.path("fixtures", "ban-fr.db"))
})

afterAll(async () => {
	await scratch[Symbol.asyncDispose]()
})

const FR_SCOPE = { countries: ["FR"], subdivisions: null }
const FR_ENTRY = { country: "FR", subdivision: null }

describe("BAN on the active selection, against its conventional path on the same bytes", () => {
	it("answers every query identically, so the difference list is empty", async () => {
		const legacy = scratch.path("legacy")
		const selected = scratch.path("selected")

		await copyFileTo(scratch.path("fixtures", "ban-fr.db"), legacy("db", "ban", "address-points-fr.db"))

		const installed = await installFixtureArtifact(
			selected,
			ServingRole.AddressPoints,
			"address-points-fr.db",
			banBytes,
			{
				scope: FR_SCOPE,
				entryScope: FR_ENTRY,
				locale: "fr",
			}
		)

		await replaceActiveSelection(selected, { basedOn: null, set: [installed.entry] })

		using before = await openBANRegionDatabases(legacy)
		using after = await openBANRegionDatabases(selected)

		const differences = FR_QUERIES.flatMap((query) => {
			const was = before.for("fr").addressPoints?.find(query) ?? null
			const now = after.for("fr").addressPoints?.find(query) ?? null

			return stringifyJSON(was) === stringifyJSON(now) ? [] : [{ query, was, now }]
		})

		const answered = FR_QUERIES.filter((query) => after.for("fr").addressPoints?.find(query))

		expect(differences).toEqual([])
		// The comparison covers hits as well as misses.
		expect(answered.length).toBeGreaterThan(0)
		expect(answered.length).toBeLessThan(FR_QUERIES.length)
	})
})

describe("POI on the active selection", () => {
	it("opens the selected POI database, with the same bytes as the conventional one", async () => {
		const legacy = scratch.path("poi-legacy")
		const selected = scratch.path("poi-selected")
		const conventional = layerDatabasePath(legacy, "poi")

		await copyFileTo(scratch.path("fixtures", "ban-fr.db"), conventional)

		const installed = await installFixtureArtifact(selected, ServingRole.POI, "poi.db", banBytes)

		await replaceActiveSelection(selected, { basedOn: null, set: [installed.entry] })

		expect(await resolveLayerDatabasePath(legacy, "poi")).toBe(conventional)
		expect(await resolveLayerDatabasePath(selected, "poi")).toBe(installed.path)
		expect(await sha256File(installed.path)).toBe(await sha256File(conventional))
	})
})

describe("overlapping national sources", () => {
	it("answers from the first readable source, and from the second only when the first is absent", async () => {
		const root = scratch.path("overlap")

		await writePoints(scratch.path("fixtures", "osm-fr.db"), "fr", "openstreetmap:fr", [
			{ street: "Rue de Rivoli", number: "2", postcode: "75001", locality: "Paris", lat: 48.85661, lon: 2.35221 },
		])

		const options = { scope: FR_SCOPE, entryScope: FR_ENTRY, locale: "fr" }
		const ban = await installFixtureArtifact(root, ServingRole.AddressPoints, "address-points-fr.db", banBytes, options)

		const osm = await installFixtureArtifact(
			root,
			ServingRole.AddressPoints,
			"address-points-fr-osm.db",
			await readLocalBuffer(scratch.path("fixtures", "osm-fr.db")),
			options
		)

		const entry: SelectionEntry = {
			role: ServingRole.AddressPoints,
			scope: FR_ENTRY,
			order: [...ban.entry.order, ...osm.entry.order],
		}

		await replaceActiveSelection(root, { basedOn: null, set: [entry] })

		const catalog = await LayerCatalog.read(root)

		expect((await catalog.resolve(ServingRole.AddressPoints, FR_ENTRY)).map((source) => source.path)).toEqual([
			ban.path,
			osm.path,
		])

		{
			using provider = await openBANRegionDatabases(root)

			expect(provider.for("fr").addressPoints?.find(FR_QUERIES[0]!)).toMatchObject({ source: "ban:fr" })
			// A miss in the first source is its answer.
			// The second is not consulted.
			expect(provider.for("fr").addressPoints?.find(FR_QUERIES[2]!) ?? null).toBeNull()
		}

		await removePath(resolveDirectory(ban.path))

		using fallback = await openBANRegionDatabases(root)

		expect(fallback.for("fr").addressPoints?.find(FR_QUERIES[0]!)).toMatchObject({ source: "openstreetmap:fr" })
	})
})

describe("a multi-country source", () => {
	it("selects one artifact scoped to four countries for each of them, and the reader opens it for each", async () => {
		const root = scratch.path("dach")
		const countries = ["AT", "CH", "DE", "LI"]

		await writePoints(scratch.path("fixtures", "osm-dach.db"), "de", "openstreetmap:dach", [
			{ street: "Unter den Linden", number: "77", postcode: "10117", locality: "Berlin", lat: 52.5163, lon: 13.3807 },
			{ street: "Stephansplatz", number: "1", postcode: "1010", locality: "Wien", lat: 48.2085, lon: 16.3731 },
		])

		const installed = await installFixtureArtifact(
			root,
			ServingRole.AddressPoints,
			"address-points-dach.db",
			await readLocalBuffer(scratch.path("fixtures", "osm-dach.db")),
			{ scope: { countries, subdivisions: null }, locale: "de" }
		)

		await replaceActiveSelection(root, {
			basedOn: null,
			set: countries.map((country) => ({
				role: ServingRole.AddressPoints,
				scope: { country, subdivision: null },
				order: installed.entry.order,
			})),
		})

		const catalog = await LayerCatalog.read(root)

		for (const country of countries) {
			expect(await catalog.firstPath(ServingRole.AddressPoints, { country, subdivision: null })).toBe(installed.path)
		}

		using lookup = new AddressPointSqliteLookup(installed.path, { streetLocale: "de" })

		expect(lookup.find({ street: "Unter den Linden", number: "77", postcode: "10117", bbox: null })).toMatchObject({
			lat: 52.5163,
		})

		expect(lookup.find({ street: "Stephansplatz", number: "1", postcode: "1010", bbox: null })).toMatchObject({
			lat: 48.2085,
		})
	})
})

describe("a non-SQLite artifact set", () => {
	it("installs an FST and its pair index as one set and resolves both, in order, for the street-morphology role", async () => {
		const root = scratch.path("fst")

		const fst = await installFixtureArtifact(
			root,
			ServingRole.StreetMorphology,
			"fst-street-morphology.bin",
			"fst bytes",
			{
				format: ArtifactFormat.FST,
			}
		)

		const pairs = await installFixtureArtifact(root, ServingRole.StreetMorphology, "pairs.pix1", "pix1 bytes", {
			format: ArtifactFormat.PairIndex,
		})

		const members = [fst, pairs].map((member) => ({
			artifactID: member.entry.order[0]!.artifactID,
			role: ServingRole.StreetMorphology,
			schemaVersion: 1,
		}))

		expect(artifactSetID(members)).toBe(artifactSetID(members.toReversed()))

		await replaceActiveSelection(root, {
			basedOn: null,
			set: [{ ...fst.entry, order: [...fst.entry.order, ...pairs.entry.order] }],
		})

		const resolved = await (await LayerCatalog.read(root)).resolve(ServingRole.StreetMorphology, fst.entry.scope)

		expect(resolved.map((source) => [source.path, source.manifest.format])).toEqual([
			[fst.path, ArtifactFormat.FST],
			[pairs.path, ArtifactFormat.PairIndex],
		])
	})
})

describe("national Overture on the active selection, against its conventional path on the same bytes", () => {
	it("answers every query identically, so the difference list is empty", async () => {
		const legacy = scratch.path("overture-legacy")
		const selected = scratch.path("overture-selected")

		const rows = [
			{ street: "Via del Corso", number: "1", postcode: "00186", locality: "Roma", lat: 41.9009, lon: 12.4783 },
			{ street: "Via Roma", number: "10", postcode: "10121", locality: "Torino", lat: 45.0677, lon: 7.6825 },
		]

		await writePoints(scratch.path("fixtures", "overture-it.db"), "it", "overture:it", rows)

		const bytes = await readLocalBuffer(scratch.path("fixtures", "overture-it.db"))

		await copyFileTo(scratch.path("fixtures", "overture-it.db"), nationalAddressPointsPath(legacy, "it"))

		const installed = await installFixtureArtifact(selected, ServingRole.AddressPoints, "address-points-it.db", bytes, {
			scope: { countries: ["IT"], subdivisions: null },
			entryScope: { country: "IT", subdivision: null },
			locale: "it",
		})

		await replaceActiveSelection(selected, { basedOn: null, set: [installed.entry] })

		using before = await OvertureNationalDatabaseProvider.create(legacy)
		using after = await OvertureNationalDatabaseProvider.create(selected)

		const queries = [
			{ street: "Via del Corso", number: "1", postcode: "00186", bbox: null },
			{ street: "Via del Corso", number: "3", postcode: "00186", bbox: null },
			{ street: "Via Roma", number: "10", postcode: "10121", bbox: null },
			{ street: "Via Roma", number: "10", postcode: "00100", bbox: null },
			{ street: "Via Roma", number: "10", locality: "Torino", bbox: null },
		]

		const differences = queries.flatMap((query) => {
			const was = before.for("it").addressPoints?.find(query) ?? null
			const now = after.for("it").addressPoints?.find(query) ?? null

			return stringifyJSON(was) === stringifyJSON(now) ? [] : [{ query, was, now }]
		})

		expect(differences).toEqual([])
		expect(queries.filter((query) => after.for("it").addressPoints?.find(query)).length).toBeGreaterThan(0)
	})
})

describe("each overlay on its own role", () => {
	it.each(["flood", "soil", "coastal", "zoning"] as const)(
		"opens the selected %s database, with the same bytes as the conventional one",
		async (id) => {
			const legacy = scratch.path(`${id}-legacy`)
			const selected = scratch.path(`${id}-selected`)
			const conventional = layerDatabasePath(legacy, id)
			const bytes = Buffer.from(`${id} overlay fixture`)

			await makeDirectories(resolveDirectory(conventional))
			await writeLocalBuffer(bytes, conventional)

			const role = {
				flood: ServingRole.FloodOverlay,
				soil: ServingRole.SoilOverlay,
				coastal: ServingRole.CoastalErosionOverlay,
				zoning: ServingRole.ZoningOverlay,
			}[id]

			const installed = await installFixtureArtifact(selected, role, `${id}.db`, bytes, {
				scope: { countries: [], subdivisions: null },
				entryScope: { country: null, subdivision: null },
			})

			await replaceActiveSelection(selected, { basedOn: null, set: [installed.entry] })

			expect(await resolveLayerDatabasePath(legacy, id)).toBe(conventional)
			expect(await resolveLayerDatabasePath(selected, id)).toBe(installed.path)
			expect(await sha256File(installed.path)).toBe(await sha256File(conventional))

			// The doctor lists the path the session reads.
			expect((await layerDatabases(selected)).find((layer) => layer.id === id)?.path).toBe(installed.path)
		}
	)
})

function resolveDirectory(path: string): string {
	return path.slice(0, path.lastIndexOf("/"))
}
