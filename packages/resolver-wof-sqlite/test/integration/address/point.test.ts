import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	AddressPointSqliteLookup,
	ADDRESS_POINT_COLUMNS,
	type AddressPointDatabase,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import {
	normalizeHouseNumberForKey,
	normalizeLocalityForKeyLocale,
	normalizeStreetForKey,
	normalizeStreetForKeyLocale,
} from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let lookup: AddressPointSqliteLookup

let fullKeys: AddressPointSqliteLookup

beforeAll(async () => {
	const dir = fixtures.use(await temporaryDirectory("ap-lookup-")).path
	const path = dir("fixture.db")
	using kdb = new DatabaseClient<AddressPointDatabase>(path)

	await createAddressPointTable(kdb)

	const insert = kdb.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

	insert.run(
		"osborne drive",
		"osborne drive",
		"32",
		null,
		"4505",
		"burpengary",
		"Osborne Drive",
		-27.1836,
		152.9567,
		"t",
		"r",
		null,
		null
	)

	insert.run(
		"osborne drive",
		"osborne drive",
		"32-36",
		null,
		"4505",
		"burpengary",
		"Osborne Drive",
		-27.9999,
		152.9999,
		"t",
		"r",
		null,
		null
	)

	insert.run("forest road", "forest road", "19", null, "7250", "trevallyn", "Forest Road", -41.4316, 147.1185, "t", "r")

	const egliseKey = normalizeStreetForKey("Rue de l'Église")

	insert.run(egliseKey, egliseKey, "3 a", null, "67530", "boersch", "Rue de l'Église", 48.4771, 7.4433, "t", "r")

	const republiqueKey = normalizeStreetForKey("Rue de la République")

	insert.run(
		republiqueKey,
		republiqueKey,
		"10",
		null,
		"77170",
		"servon",
		"Rue de la République",
		48.718479,
		2.587971,
		"ban:fr",
		"r",
		null,
		null
	)

	const teichKey = normalizeStreetForKey("Teichstraße")
	insert.run(teichKey, teichKey, "3", null, "04509", "werlitzsch", "Teichstraße", 51.4367, 12.1958, "osm", "r")
	insert.run(teichKey, teichKey, "3", null, "04509", "krensitz", "Teichstraße", 51.52, 12.45, "osm", "r")

	insert.run("mill lane", "mill lane", "7", null, null, null, "Mill Lane", 51.5, -0.1, "osm", "r")

	const airportKey = normalizeStreetForKey("Airport Pkwy")

	insert.run(
		airportKey,
		airportKey,
		"4900",
		null,
		"75001",
		"addi",
		"AIRPORT Parkway",
		32.965477444,
		-96.82785054,
		"overture:NAD",
		"r",
		null,
		null
	)

	lookup = new AddressPointSqliteLookup(path)
	fullKeys = new AddressPointSqliteLookup(path, { localityKeys: "full" })
})

describe("AddressPointSqliteLookup", () => {
	it("answers an exact (street, number) within the postcode scope", () => {
		expect(lookup.find({ street: "Osborne Drive", number: "32", postcode: "4505" })?.lat).toBe(-27.1836)
	})

	it("prefers a verbatim range key over the low-end fallback", () => {
		expect(lookup.find({ street: "Osborne Drive", number: "32-36", postcode: "4505" })?.lat).toBe(-27.9999)
	})

	it("falls back to the range's low end when the range key misses", () => {
		expect(lookup.find({ street: "Forest Road", number: "19-21", postcode: "7250" })?.lat).toBe(-41.4316)
		expect(lookup.find({ street: "Forest Road", number: "19-21", locality: "Trevallyn" })?.lat).toBe(-41.4316)
	})

	it("stays null when neither the range key nor its low end exists", () => {
		expect(lookup.find({ street: "Forest Road", number: "23-25", postcode: "7250" })).toBeNull()
	})

	it("never treats a plain number as a range", () => {
		expect(lookup.find({ street: "Forest Road", number: "21", postcode: "7250" })).toBeNull()
	})

	it("bridges letter-suffix spacing in both directions, then falls to the base number", () => {
		expect(lookup.find({ street: "Rue de l'Église", number: "3a", postcode: "67530" })?.lat).toBe(48.4771)
		expect(lookup.find({ street: "Rue de l'Église", number: "3 a", postcode: "67530" })?.lat).toBe(48.4771)

		expect(lookup.find({ street: "Forest Road", number: "19a", postcode: "7250" })?.lat).toBe(-41.4316)

		expect(lookup.find({ street: "Rue de l'Église", number: "4a", postcode: "67530" })).toBeNull()
	})

	it("never range-splits or suffix-folds the unit-containing and box shapes", () => {
		expect(lookup.find({ street: "Osborne Drive", number: "5/32", postcode: "4505" })).toBeNull()

		expect(lookup.find({ street: "Osborne Drive", number: "32 1/2", postcode: "4505" })).toBeNull()

		expect(lookup.find({ street: "Osborne Drive", number: "unit 32", postcode: "4505" })).toBeNull()
		expect(lookup.find({ street: "Osborne Drive", number: "apt 3a", postcode: "4505" })).toBeNull()

		expect(lookup.find({ street: "PO Box", number: "123-125", postcode: "4505" })).toBeNull()
	})

	it("unit siblings share the building coordinate through every rung", () => {
		const base = lookup.find({ street: "Osborne Drive", number: "32", postcode: "4505" })
		const viaRange = lookup.find({ street: "Osborne Drive", number: "32-36", postcode: "4505" })

		expect(base?.lat).toBeDefined()

		expect(viaRange?.lat).toBe(-27.9999)
	})

	it("carries the register row's own locality and postcode on the hit", () => {
		const hit = lookup.find({ street: "Osborne Drive", number: "32", postcode: "4505" })

		expect(hit?.localityNorm).toBe("burpengary")
		expect(hit?.postcode).toBe("4505")
	})
})

describe("The bbox fall-through's scope contradiction", () => {
	const parisBox = { minLat: 48.5, maxLat: 49.1, minLon: 2, maxLon: 2.8 }

	it("refuses a row whose own postcode names a different place than the query's", () => {
		expect(
			fullKeys.find({
				street: "Rue de la République",
				number: "10",
				postcode: "75008",
				locality: "Paris",
				bbox: parisBox,
			})
		).toBeNull()
	})

	it("refuses a row whose own locality disagrees when the query names no postcode", () => {
		expect(
			fullKeys.find({ street: "Rue de la République", number: "10", locality: "Paris", bbox: parisBox })
		).toBeNull()
	})

	it("still answers a scope-less point inside the box, and a scoped row through its scoped rung", () => {
		const londonBox = { minLat: 51.4, maxLat: 51.6, minLon: -0.2, maxLon: 0 }

		expect(fullKeys.find({ street: "Mill Lane", number: "7", locality: "London", bbox: londonBox })?.lat).toBe(51.5)
		expect(fullKeys.find({ street: "Rue de la République", number: "10", postcode: "77170" })?.lat).toBe(48.718479)
	})
})

describe("The postcode rung's locality contradiction", () => {
	it("answers the row whose locality agrees, whichever village the query names", () => {
		expect(fullKeys.find({ street: "Teichstraße", number: "3", postcode: "04509", locality: "Krensitz" })?.lat).toBe(
			51.52
		)

		expect(fullKeys.find({ street: "Teichstraße", number: "3", postcode: "04509", locality: "Werlitzsch" })?.lat).toBe(
			51.4367
		)
	})

	it("answers nothing when the query names a third place under the same postcode — admin is the better answer", () => {
		expect(fullKeys.find({ street: "Teichstraße", number: "3", postcode: "04509", locality: "Schönwölkau" })).toBeNull()
	})

	it("keeps answering by postcode alone when the query names no locality", () => {
		expect(fullKeys.find({ street: "Teichstraße", number: "3", postcode: "04509" })).not.toBeNull()
	})

	it("Never refuses on the locality under the US extract, whose keys are abbreviated ( follow-up)", () => {
		const hit = lookup.find({ street: "Airport Pkwy", number: "4900", postcode: "75001", locality: "Addison" })

		expect(hit?.lat).toBe(32.965477444)
		expect(hit?.localityNorm).toBe("addi")

		expect(lookup.find({ street: "Airport Pkwy", number: "4900", postcode: "75001", locality: "Dallas" })?.lat).toBe(
			32.965477444
		)
	})

	it("holds a full-name extract to the locality it names", () => {
		expect(fullKeys.find({ street: "Airport Pkwy", number: "4900", postcode: "75001", locality: "Dallas" })).toBeNull()
	})
})

describe("a zh extract — the Taiwanese register keyed by 縣市 + 鄉鎮市區", () => {
	let zh: AddressPointSqliteLookup

	beforeAll(async () => {
		const dir = fixtures.use(await temporaryDirectory("ap-lookup-zh-")).path
		const path = dir("tw.db")
		using kdb = new DatabaseClient<AddressPointDatabase>(path)

		await createAddressPointTable(kdb)

		const insert = kdb.prepare(`INSERT INTO address_point VALUES (${ADDRESS_POINT_COLUMNS.map(() => "?").join(", ")})`)

		const rows: Array<[string, string, string, string | null, string]> = [
			["臺北市中正區", "重慶南路一段", "１２２號", null, "建國里"],
			["基隆市中正區", "中正路", "１２２號", null, "正義里"],
			["高雄市旗津區", "旗下巷", "１４", "之１２號", "旗下里"],
		]

		for (const [scope, street, number, unit, village] of rows) {
			const streetNorm = normalizeStreetForKeyLocale(street, "zh")

			insert.run(
				streetNorm,
				streetNorm,
				normalizeHouseNumberForKey(number, "zh"),
				unit,
				null,
				normalizeLocalityForKeyLocale(scope, "zh"),
				street,
				scope.startsWith("臺北") ? 25.0399658 : scope.startsWith("基隆") ? 25.1283 : 22.6133451,
				scope.startsWith("臺北") ? 121.5124584 : scope.startsWith("基隆") ? 121.7419 : 120.2650804,
				"overture:OpenAddresses/Taipei City Government Civil Affairs Bureau",
				"2026-06-17.0",
				village,
				null
			)
		}

		zh = fixtures.use(new AddressPointSqliteLookup(path, { streetLocale: "zh" }))
	})

	it("answers the parse's region + subregion as the scope, with the common 台 for the register's 臺", () => {
		const hit = zh.find({ street: "重慶南路一段", number: "122號", region: "台北市", subregion: "中正區" })

		expect(hit).toMatchObject({ lat: 25.0399658, lon: 121.5124584, localityNorm: "台北市中正區" })
	})

	it("keeps the two 中正區 apart: Keelung's 中正路 122 is not Taipei's", () => {
		expect(zh.find({ street: "中正路", number: "122號", region: "台北市", subregion: "中正區" })).toBeNull()
		expect(zh.find({ street: "中正路", number: "122", region: "基隆市", subregion: "中正區" })?.lat).toBe(25.1283)
	})

	it("falls from a sub-number to its base number, in either written order", () => {
		const scope = { region: "高雄市", subregion: "旗津區" }

		expect(zh.find({ street: "旗下巷", number: "14之12號", ...scope })?.lat).toBe(22.6133451)
		expect(zh.find({ street: "旗下巷", number: "14號之12", ...scope })?.lat).toBe(22.6133451)
		expect(zh.find({ street: "旗下巷", number: "１４號之１２", ...scope })?.lat).toBe(22.6133451)

		expect(zh.find({ street: "旗下巷", number: "14附3號", ...scope })?.lat).toBe(22.6133451)
		expect(zh.find({ street: "旗下巷", number: "14之12附1號", ...scope })?.lat).toBe(22.6133451)
	})

	it("matches the stored pair by its tail when the line names only the 鄉鎮市區", () => {
		expect(zh.find({ street: "重慶南路一段", number: "122號", subregion: "中正區" })?.lat).toBe(25.0399658)
		expect(zh.find({ street: "中正路", number: "122號", subregion: "中正區" })?.lat).toBe(25.1283)
		expect(zh.find({ street: "中正路", number: "122號", subregion: "信義區" })).toBeNull()
	})

	it("a scope-less query misses rather than answering the first row of the street", () => {
		expect(zh.find({ street: "重慶南路一段", number: "122號" })).toBeNull()
	})
})
