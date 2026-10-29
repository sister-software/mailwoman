/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every reader on the active selection, compared with its conventional path on fixed bytes, and the
 *   overlapping-national, multi-country and FST artifact-set fixtures opened through the catalog.
 *
 *   The readers compared: BAN, POI, national Overture, the four overlays, the OpenStreetMap extract provider,
 *   the Nominatim and Photon rooftop providers, the WOF extract set, the autocomplete FST, and the gazetteer
 *   and street-morphology FSTs a parse reads.
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
import {
	artifactSetID,
	ArtifactFormat,
	BuildRecipeName,
	type SelectionEntry,
	ServingRole,
} from "@mailwoman/core/layers"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import {
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	AddressPointSqliteLookup,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import { deserializeFST, serializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { buildPlaceSearchFTS } from "@mailwoman/resolver-wof-sqlite/fts"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { loadStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street"
import {
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder, PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { resolveFSTPath, runAutocomplete } from "#autocomplete-core"
import { LayerCatalog, replaceActiveSelection } from "#data/catalog"
import { openBANRegionDatabases } from "#geocode/ban-layers"
import { gazetteerFSTScope, selectedParsePriorArtifacts } from "#geocode/fst-layers"
import { layerDatabasePath, layerDatabases, resolveLayerDatabasePath } from "#geocode/layer-paths"
import { nationalAddressPointsPath, OvertureNationalDatabaseProvider } from "#geocode/national-overture"
import { openOSMRegionDatabases } from "#geocode/osm-layers"
import { openServingRooftopProviders } from "#geocode/serving-layers"
import { existingWOFDatabasePaths } from "#resolver-backend"
import { installFixtureArtifact } from "#test-kit/fixture-registry"
import { buildFixtureFST, FIXTURE_FST_PLACES } from "#test-kit/fst-fixture"

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

/**
 * The difference list of two arms over the same queries: every query whose answers serialize differently.
 */
function differencesOf<Q, A>(queries: readonly Q[], before: (query: Q) => A, after: (query: Q) => A) {
	return queries.flatMap((query) => {
		const was = before(query) ?? null
		const now = after(query) ?? null

		return stringifyJSON(was) === stringifyJSON(now) ? [] : [{ query, was, now }]
	})
}

const DE_ROWS = [
	{ street: "Unter den Linden", number: "77", postcode: "10117", locality: "Mitte", lat: 52.5163, lon: 13.3807 },
	{ street: "Friedrichstraße", number: "43", postcode: "10117", locality: "Mitte", lat: 52.5076, lon: 13.3904 },
]

const DE_QUERIES = [
	{ street: "Unter den Linden", number: "77", postcode: "10117", bbox: null },
	{ street: "Unter den Linden", number: "79", postcode: "10117", bbox: null },
	{ street: "Friedrichstr.", number: "43", postcode: "10117", bbox: null },
	{ street: "Friedrichstraße", number: "43", locality: "Mitte", bbox: null },
	{ street: "Friedrichstraße", number: "43", postcode: "80331", bbox: null },
]

const OSM_DE_SCOPE = {
	scope: { countries: ["DE"], subdivisions: null },
	entryScope: { country: "DE", subdivision: null },
	locale: "de",
	recipe: BuildRecipeName.OSMAddressPoints,
}

describe("the OpenStreetMap extract provider on the active selection, against its conventional path", () => {
	it("answers every query identically on the same bytes, so the difference list is empty", async () => {
		const legacy = scratch.path("osm-legacy")
		const selected = scratch.path("osm-selected")

		await writePoints(scratch.path("fixtures", "osm-de.db"), "de", "openstreetmap:de", DE_ROWS)
		await copyFileTo(scratch.path("fixtures", "osm-de.db"), legacy("db", "osm", "address-points-de-de.db"))

		const installed = await installFixtureArtifact(
			selected,
			ServingRole.AddressPoints,
			"address-points-de.db",
			await readLocalBuffer(scratch.path("fixtures", "osm-de.db")),
			OSM_DE_SCOPE
		)

		await replaceActiveSelection(selected, { basedOn: null, set: [installed.entry] })

		using before = (await openOSMRegionDatabases(legacy))!
		using after = (await openOSMRegionDatabases(selected))!

		const differences = differencesOf(
			DE_QUERIES,
			(query) => before.for("de").addressPoints?.find(query),
			(query) => after.for("de").addressPoints?.find(query)
		)

		expect(differences).toEqual([])
		expect(DE_QUERIES.filter((query) => after.for("de").addressPoints?.find(query))).toHaveLength(3)
		// A country the selection does not list keeps its conventional path, which holds no file here.
		expect(after.for("nl")).toEqual({})
	})

	it("reads an OpenStreetMap build only in the OpenStreetMap tier when one entry lists it after BAN", async () => {
		const root = scratch.path("osm-after-ban")

		await writePoints(scratch.path("fixtures", "osm-fr-built.db"), "fr", "openstreetmap:fr", [
			{ street: "Rue de Rivoli", number: "4", postcode: "75001", locality: "Paris", lat: 48.857, lon: 2.351 },
		])

		const options = { scope: FR_SCOPE, entryScope: FR_ENTRY, locale: "fr" }
		const ban = await installFixtureArtifact(root, ServingRole.AddressPoints, "address-points-fr.db", banBytes, options)

		const osm = await installFixtureArtifact(
			root,
			ServingRole.AddressPoints,
			"address-points-fr-osm.db",
			await readLocalBuffer(scratch.path("fixtures", "osm-fr-built.db")),
			{ ...options, recipe: BuildRecipeName.OSMAddressPoints }
		)

		await replaceActiveSelection(root, {
			basedOn: null,
			set: [{ role: ServingRole.AddressPoints, scope: FR_ENTRY, order: [...ban.entry.order, ...osm.entry.order] }],
		})

		{
			using providers = await openServingRooftopProviders(root)

			// The national tier reads BAN, and a miss there stays its answer.
			expect(providers.national.for("fr").addressPoints?.find(FR_QUERIES[0]!)).toMatchObject({ source: "ban:fr" })
			expect(providers.national.for("fr").addressPoints?.find(FR_QUERIES[2]!) ?? null).toBeNull()

			// The OpenStreetMap tier reads the build, as it read its own file beside BAN's before the selection.
			expect(providers.osm?.for("fr").addressPoints?.find(FR_QUERIES[2]!)).toMatchObject({
				source: "openstreetmap:fr",
			})
		}

		await removePath(resolveDirectory(ban.path))

		using fallback = await openServingRooftopProviders(root)

		// With BAN gone, the national tier reads its conventional path, and the build stays the OpenStreetMap tier's.
		expect(fallback.national.for("fr").addressPoints).toBeUndefined()
		expect(fallback.osm?.for("fr").addressPoints?.find(FR_QUERIES[2]!)).toMatchObject({ source: "openstreetmap:fr" })
	})
})

describe("the Nominatim and Photon rooftop providers on the active selection, against their conventional paths", () => {
	it("answer every BAN and OpenStreetMap query identically on the same bytes", async () => {
		const legacy = scratch.path("serving-legacy")
		const selected = scratch.path("serving-selected")
		const osmBytes = await readLocalBuffer(scratch.path("fixtures", "osm-de.db"))

		await copyFileTo(scratch.path("fixtures", "ban-fr.db"), legacy("db", "ban", "address-points-fr.db"))
		await copyFileTo(scratch.path("fixtures", "osm-de.db"), legacy("db", "osm", "address-points-de-de.db"))

		const ban = await installFixtureArtifact(selected, ServingRole.AddressPoints, "address-points-fr.db", banBytes, {
			scope: FR_SCOPE,
			entryScope: FR_ENTRY,
			locale: "fr",
		})

		const osm = await installFixtureArtifact(
			selected,
			ServingRole.AddressPoints,
			"address-points-de.db",
			osmBytes,
			OSM_DE_SCOPE
		)

		await replaceActiveSelection(selected, { basedOn: null, set: [ban.entry, osm.entry] })

		using before = await openServingRooftopProviders(legacy)
		using after = await openServingRooftopProviders(selected)

		expect(before.generation).toBeNull()
		expect(after.generation).toBe(1)

		const banDifferences = differencesOf(
			FR_QUERIES,
			(query) => before.national.for("fr").addressPoints?.find(query),
			(query) => after.national.for("fr").addressPoints?.find(query)
		)

		const osmDifferences = differencesOf(
			DE_QUERIES,
			(query) => before.osm?.for("de").addressPoints?.find(query),
			(query) => after.osm?.for("de").addressPoints?.find(query)
		)

		expect({ ban: banDifferences, osm: osmDifferences }).toEqual({ ban: [], osm: [] })
	})
})

/**
 * Write a WOF FTS extract with the given `spr` rows.
 */
function writeWOFExtract(path: PathBuilder, rows: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		${rows}
	`)

	buildPlaceSearchFTS(db)
}

describe("the WOF extract set on the active selection, against the conventional set", () => {
	it("attaches the same files in the same order and answers every query identically", async () => {
		const legacy = scratch.path("wof-legacy")
		const selected = scratch.path("wof-selected")
		const [adminName, postcodeName] = ["admin-global-priority.db", "postalcode-us.db"]

		writeWOFExtract(
			scratch.path("fixtures", adminName),
			`INSERT INTO spr VALUES (101, NULL, 'Springfield', 'locality', 'US', 39.80, -89.65, 39.75, 39.85, -89.70, -89.60, -1, 0);
			 INSERT INTO spr VALUES (103, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);`
		)

		writeWOFExtract(
			scratch.path("fixtures", postcodeName),
			`INSERT INTO spr VALUES (201, 101, '62701', 'postalcode', 'US', 39.80, -89.65, 39.78, 39.82, -89.67, -89.63, 1, 0);`
		)

		const set: SelectionEntry[] = []

		for (const name of [adminName, postcodeName]) {
			await copyFileTo(scratch.path("fixtures", name), wofDatabaseRoot(legacy)(name))

			const installed = await installFixtureArtifact(
				selected,
				ServingRole.WOFExtract,
				name,
				await readLocalBuffer(scratch.path("fixtures", name)),
				{ scope: { countries: [], subdivisions: null }, entryScope: { country: null, subdivision: null } }
			)

			set.push(installed.entry)
		}

		await replaceActiveSelection(selected, {
			basedOn: null,
			set: [{ ...set[0]!, order: set.flatMap((entry) => entry.order) }],
		})

		const legacyPaths = await existingWOFDatabasePaths(null, legacy)
		const selectedPaths = await existingWOFDatabasePaths(null, selected)

		// The lookup names each attached schema after its file, so an installed extract keeps its file name.
		expect(selectedPaths.map((path) => path.split("/").at(-1))).toEqual([adminName, postcodeName])

		expect(await Promise.all(selectedPaths.map((path) => sha256File(path)))).toEqual(
			await Promise.all(legacyPaths.map((path) => sha256File(path)))
		)

		using before = new WOFSQLitePlaceLookup({ databasePath: legacyPaths })
		using after = new WOFSQLitePlaceLookup({ databasePath: selectedPaths })

		const queries = [
			{ text: "Springfield", placetype: "locality" },
			{ text: "Paris", placetype: "locality" },
			{ text: "62701", placetype: "postalcode" },
			{ text: "62702", placetype: "postalcode" },
			{ text: "Nowhere", placetype: "locality" },
		] as const

		const answers = async (lookup: WOFSQLitePlaceLookup) =>
			Promise.all(queries.map(async (query) => (await lookup.findPlace({ ...query })).map((place) => place.id)))

		const was = await answers(before)
		const now = await answers(after)

		expect(
			differencesOf(
				[...queries.keys()],
				(index) => was[index],
				(index) => now[index]
			)
		).toEqual([])

		expect(now.filter((ids) => ids.length)).toHaveLength(3)
	})
})

describe("the FSTs on the active selection, against the files beside the weights and under the data root", () => {
	it("autocompletes every prefix identically from the selected gazetteer FST", async () => {
		const legacy = scratch.path("fst-legacy")
		const selected = scratch.path("fst-selected")
		const bytes = serializeFST(buildFixtureFST(FIXTURE_FST_PLACES))

		await makeDirectories(wofDatabaseRoot(legacy)("fst-per-locale"))
		await writeLocalBuffer(bytes, wofDatabaseRoot(legacy)("fst-per-locale", "fst-en-us.bin"))

		const installed = await installFixtureArtifact(selected, ServingRole.GazetteerFST, "fst-en-us.bin", bytes, {
			format: ArtifactFormat.FST,
			scope: { countries: ["US"], subdivisions: null },
			entryScope: gazetteerFSTScope("en-US"),
		})

		await replaceActiveSelection(selected, { basedOn: null, set: [installed.entry] })

		const legacyPath = await resolveFSTPath(undefined, legacy)
		const selectedPath = await resolveFSTPath(undefined, selected)

		expect(selectedPath).toBe(installed.path)

		const prefixes = ["new", "new y", "san", "san j", "united", "x"]

		const run = (fstPath: PathBuilderLike) =>
			Promise.all(prefixes.map((prefix) => runAutocomplete(prefix, { fstPath })))

		const was = await run(legacyPath)
		const now = await run(selectedPath)

		expect(
			differencesOf(
				[...prefixes.keys()],
				(index) => was[index],
				(index) => now[index]
			)
		).toEqual([])

		expect(now.filter((entries) => entries.length)).toHaveLength(5)
	})

	it("reads the selected gazetteer and street-morphology FSTs in place of the weights' siblings", async () => {
		const selected = scratch.path("fst-priors-selected")
		const bytes = serializeFST(buildFixtureFST(FIXTURE_FST_PLACES))
		const weightsSibling = scratch.path("fixtures", "fst-en-us.bin").toString()

		await writeLocalBuffer(bytes, weightsSibling)

		const gazetteer = await installFixtureArtifact(selected, ServingRole.GazetteerFST, "fst-en-us.bin", bytes, {
			format: ArtifactFormat.FST,
			scope: { countries: ["US"], subdivisions: null },
			entryScope: gazetteerFSTScope("en-US"),
		})

		const morphology = await installFixtureArtifact(
			selected,
			ServingRole.StreetMorphology,
			"fst-street-morphology.bin",
			bytes,
			{
				format: ArtifactFormat.FST,
				scope: { countries: [], subdivisions: null },
				entryScope: { country: null, subdivision: null },
			}
		)

		await replaceActiveSelection(selected, { basedOn: null, set: [gazetteer.entry, morphology.entry] })

		const weights = { fstPath: weightsSibling, streetMorphologyPath: weightsSibling, postcodePrefixPaths: [] }
		const empty = scratch.path("fst-priors-empty")

		// No selection: the weights' own files, unchanged.
		expect(await selectedParsePriorArtifacts(weights, "en-US", empty)).toEqual(weights)

		const chosen = await selectedParsePriorArtifacts(weights, "en-US", selected)

		expect(chosen).toEqual({ ...weights, fstPath: gazetteer.path, streetMorphologyPath: morphology.path })
		// A locale of another country has no entry and keeps the weights' FST.
		expect((await selectedParsePriorArtifacts(weights, "en-GB", selected)).fstPath).toBe(weightsSibling)

		const tokens = [["new", "york"], ["new", "york", "city"], ["san", "jose"], ["paris"]]

		const walk = async (path: PathBuilderLike) => {
			const matcher = deserializeFST(await readLocalBuffer(path))

			return tokens.map((sequence) => matcher.walk(sequence))
		}

		const was = await walk(weightsSibling)
		const now = await walk(chosen.fstPath!)

		expect(
			differencesOf(
				[...tokens.keys()],
				(index) => was[index],
				(index) => now[index]
			)
		).toEqual([])

		const morphologyWas = (await loadStreetMorphologyFST({ artifactPath: weightsSibling })).matcher
		const morphologyNow = (await loadStreetMorphologyFST({ artifactPath: chosen.streetMorphologyPath! })).matcher

		expect(
			differencesOf(
				tokens,
				(sequence) => morphologyWas.walk(sequence),
				(sequence) => morphologyNow.walk(sequence)
			)
		).toEqual([])
	})
})

function resolveDirectory(path: string): string {
	return path.slice(0, path.lastIndexOf("/"))
}
