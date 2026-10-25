import { expect, test } from "vitest"

import {
	buildTelecomPOISQL,
	extractOSMPOIs,
	matchOSMPOITagRule,
	mergeStationComplexes,
	OSM_POI_RULE_SETS,
	STATION_TAG_RULES,
	stationNames,
	tagRuleFromOSMTag,
	TELECOM_TAG_RULES,
	toPOISourceRows,
} from "#sdk/extract/poi"

test("STATION_TAG_RULES: a subway or light-rail station takes its own category before the plain station rule", () => {
	expect(matchOSMPOITagRule({ railway: "station", station: "subway" }, STATION_TAG_RULES)).toBe("metro_station")

	expect(matchOSMPOITagRule({ railway: "station", station: "light_rail" }, STATION_TAG_RULES)).toBe(
		"light_rail_and_subway_station"
	)

	expect(matchOSMPOITagRule({ railway: "station" }, STATION_TAG_RULES)).toBe("train_station")
	expect(matchOSMPOITagRule({ railway: "halt" }, STATION_TAG_RULES)).toBe("train_station")
	expect(matchOSMPOITagRule({ railway: "platform" }, STATION_TAG_RULES)).toBeNull()
})

test("toPOISourceRows: a matched feature yields a row with its string category", () => {
	const rows = toPOISourceRows(
		{
			properties: { name: "NTT 局", man_made: "telephone_exchange" },
			geometry: { type: "Point", coordinates: [139.7, 35.6] },
		},
		{ rules: TELECOM_TAG_RULES },
		["man_made", "telecom"]
	)

	expect(rows).toEqual([expect.objectContaining({ name: "NTT 局", category: "telecom_exchange", latitude: 35.6 })])
})

test("toPOISourceRows: a station yields one row per language name, each with its station word", () => {
	const rows = toPOISourceRows(
		{
			properties: { name: "渋谷", railway: "station", name_ja: "渋谷", name_en: "Shibuya" },
			geometry: { type: "Point", coordinates: [139.7017647, 35.65808] },
		},
		OSM_POI_RULE_SETS["stations"]!,
		["railway", "station", "name:ja", "name:en"]
	)

	expect(rows.map((row) => row.name)).toEqual(["渋谷駅", "Shibuya Station"])
	expect(new Set(rows.map((row) => row.category))).toEqual(new Set(["train_station"]))
})

test("mergeStationComplexes: one station's nodes merge, and two stations of one name stay apart", () => {
	const row = (name: string, latitude: number, longitude: number) => ({
		name,
		category: "train_station",
		brandWikidata: null,
		latitude,
		longitude,
		country: "JP",
		confidence: 1,
		gersID: null,
	})

	const merged = mergeStationComplexes([
		row("渋谷駅", 35.65808, 139.7017647),
		row("渋谷駅", 35.658999, 139.7024447),
		row("渋谷駅", 35.6585367, 139.6991599),
		// A second 渋谷駅 far from Tokyo.
		row("渋谷駅", 34.827, 135.44),
		row("新宿駅", 35.6905828, 139.6991102),
		{ ...row("新宿駅", 35.6922273, 139.7006009), category: "metro_station" },
	])

	expect(merged.filter((r) => r.name === "渋谷駅")).toHaveLength(2)
	expect(merged.filter((r) => r.name === "新宿駅")).toHaveLength(1)
	expect(merged.some((r) => r.name === "渋谷駅" && r.latitude === 35.65808)).toBe(true)
})

test("stationNames: keeps a name that already ends in its station word once", () => {
	expect(stationNames({ "name:ja": "東京駅", "name:en": "Tokyo Station" })).toEqual(["東京駅", "Tokyo Station"])
	expect(stationNames({})).toEqual([])
})

test("STATION_TAG_RULES: every entry passes the SQL validator", () => {
	expect(() => buildTelecomPOISQL("points", STATION_TAG_RULES)).not.toThrow()
	expect(() => buildTelecomPOISQL("multipolygons", STATION_TAG_RULES)).not.toThrow()
})

test("TELECOM_TAG_RULES: encodes exactly the six decision-2 rules", () => {
	expect(TELECOM_TAG_RULES).toEqual([
		{ categoryID: "telecom_exchange", all: [["man_made", "telephone_exchange"]] },
		{ categoryID: "telecom_exchange", all: [["telecom", "exchange"]] },
		{
			categoryID: "telecom_cabinet",
			all: [
				["man_made", "street_cabinet"],
				["street_cabinet", "telecom"],
			],
		},
		{
			categoryID: "tower_comms",
			all: [
				["man_made", "mast"],
				["tower:type", "communication"],
			],
		},
		{ categoryID: "data_center", all: [["man_made", "data_center"]] },
		{ categoryID: "data_center", all: [["telecom", "data_center"]] },
	])
})

test("matchOSMPOITagRule: telecom_exchange matches either OR branch", () => {
	expect(matchOSMPOITagRule({ man_made: "telephone_exchange" })).toBe("telecom_exchange")
	expect(matchOSMPOITagRule({ telecom: "exchange" })).toBe("telecom_exchange")

	expect(matchOSMPOITagRule({ man_made: "telephone_exchange", telecom: "exchange" })).toBe("telecom_exchange")
})

test("matchOSMPOITagRule: telecom_cabinet requires BOTH tags (AND, not OR)", () => {
	expect(matchOSMPOITagRule({ man_made: "street_cabinet", street_cabinet: "telecom" })).toBe("telecom_cabinet")

	expect(matchOSMPOITagRule({ man_made: "street_cabinet" })).toBeNull()
	expect(matchOSMPOITagRule({ street_cabinet: "telecom" })).toBeNull()
})

test("matchOSMPOITagRule: tower_comms requires BOTH man_made=mast AND tower:type=communication", () => {
	expect(matchOSMPOITagRule({ man_made: "mast", "tower:type": "communication" })).toBe("tower_comms")

	expect(matchOSMPOITagRule({ man_made: "mast" })).toBeNull()
	expect(matchOSMPOITagRule({ man_made: "mast", "tower:type": "lighting" })).toBeNull()
})

test("matchOSMPOITagRule: data_center matches either OR branch", () => {
	expect(matchOSMPOITagRule({ man_made: "data_center" })).toBe("data_center")
	expect(matchOSMPOITagRule({ telecom: "data_center" })).toBe("data_center")
})

test("matchOSMPOITagRule: unrelated tags match nothing", () => {
	expect(matchOSMPOITagRule({ highway: "bus_stop" })).toBeNull()
	expect(matchOSMPOITagRule({})).toBeNull()
})

test("matchOSMPOITagRule: honors a custom rule table over the default", () => {
	const customRules = [{ categoryID: "custom_thing", all: [["foo", "bar"]] as Array<[string, string]> }]

	expect(matchOSMPOITagRule({ man_made: "telephone_exchange" }, customRules)).toBeNull()
	expect(matchOSMPOITagRule({ foo: "bar" }, customRules)).toBe("custom_thing")
})

test("buildTelecomPOISQL: selects promoted columns bare and hstore keys via hstore_get_value", () => {
	const sql = buildTelecomPOISQL("points")

	expect(sql).toContain("FROM points")

	expect(sql).toContain("SELECT name,")
	expect(sql).toMatch(/\bman_made='telephone_exchange'/)
	expect(sql).toMatch(/\bman_made AS man_made\b/)

	expect(sql).toContain(`hstore_get_value(other_tags,'telecom') AS telecom`)
	expect(sql).toContain(`hstore_get_value(other_tags,'street_cabinet') AS street_cabinet`)

	expect(sql).toContain(`hstore_get_value(other_tags,'tower:type') AS tower_type`)
})

test("buildTelecomPOISQL: WHERE ORs each rule's AND-group, matching TELECOM_TAG_RULES order", () => {
	const sql = buildTelecomPOISQL("multipolygons")
	const whereClause = sql.slice(sql.indexOf("WHERE"))

	expect(whereClause).toBe(
		"WHERE (man_made='telephone_exchange') OR (hstore_get_value(other_tags,'telecom')='exchange') OR " +
			"(man_made='street_cabinet' AND hstore_get_value(other_tags,'street_cabinet')='telecom') OR " +
			"(man_made='mast' AND hstore_get_value(other_tags,'tower:type')='communication') OR " +
			"(man_made='data_center') OR (hstore_get_value(other_tags,'telecom')='data_center')"
	)
})

test("buildTelecomPOISQL: parameterizes the layer name", () => {
	expect(buildTelecomPOISQL("points")).toContain("FROM points WHERE")
	expect(buildTelecomPOISQL("multipolygons")).toContain("FROM multipolygons WHERE")
})

test("buildTelecomPOISQL: pure — identical rules produce byte-identical SQL", () => {
	expect(buildTelecomPOISQL("points", TELECOM_TAG_RULES)).toBe(buildTelecomPOISQL("points", TELECOM_TAG_RULES))
})

test("BuildTelecomPOISQL: honors a custom rule table (single OR-less rule without hstore keys)", () => {
	const sql = buildTelecomPOISQL("points", [{ categoryID: "x", all: [["man_made", "y"]] }])

	expect(sql).toBe("SELECT name, man_made AS man_made FROM points WHERE (man_made='y')")
})

test("buildTelecomPOISQL: rejects a hostile rule VALUE (SQL injection attempt)", () => {
	const hostileRules = [{ categoryID: "x", all: [["man_made", "a' OR 1=1 --"] as [string, string]] }]

	expect(() => buildTelecomPOISQL("points", hostileRules)).toThrow(/tag-token allowlist/)
})

test("buildTelecomPOISQL: rejects a hostile rule KEY (SQL injection attempt)", () => {
	const hostileRules = [{ categoryID: "x", all: [["man_made'; DROP TABLE points; --", "y"] as [string, string]] }]

	expect(() => buildTelecomPOISQL("points", hostileRules)).toThrow(/tag-token allowlist/)
})

test("buildTelecomPOISQL: every TELECOM_TAG_RULES entry passes the validator", () => {
	expect(() => buildTelecomPOISQL("points", TELECOM_TAG_RULES)).not.toThrow()
	expect(() => buildTelecomPOISQL("multipolygons", TELECOM_TAG_RULES)).not.toThrow()
})

test("extractOSMPOIs: also rejects a hostile rule table before ever spawning ogr2ogr", async () => {
	const hostileRules = [{ categoryID: "x", all: [["man_made", "a' OR 1=1 --"] as [string, string]] }]
	const it = extractOSMPOIs("/nonexistent.pbf", hostileRules)[Symbol.asyncIterator]()

	await expect(it.next()).rejects.toThrow(/tag-token allowlist/)
})

test("buildTelecomPOISQL: a key promoted on one layer only is read the right way on each", () => {
	const rules = [{ categoryID: "pharmacy", all: [["amenity", "pharmacy"] as [string, string]] }]

	expect(buildTelecomPOISQL("points", rules)).toBe(
		"SELECT name, hstore_get_value(other_tags,'amenity') AS amenity FROM points WHERE " +
			"(hstore_get_value(other_tags,'amenity')='pharmacy')"
	)

	expect(buildTelecomPOISQL("multipolygons", rules)).toBe(
		"SELECT name, amenity AS amenity FROM multipolygons WHERE (amenity='pharmacy')"
	)
})

test("buildTelecomPOISQL: refuses a layer it has no promoted-key list for", () => {
	expect(() => buildTelecomPOISQL("lines", TELECOM_TAG_RULES)).toThrow(/no promoted-key list/)
})

test("tagRuleFromOSMTag: splits a taxonomy osmTag into a single-conjunct rule", () => {
	expect(tagRuleFromOSMTag("pharmacy", "amenity=pharmacy")).toEqual({
		categoryID: "pharmacy",
		all: [["amenity", "pharmacy"]],
	})
})

test("tagRuleFromOSMTag: refuses a malformed osmTag rather than guessing at it", () => {
	expect(() => tagRuleFromOSMTag("x", "amenity")).toThrow(/malformed osmTag/)
	expect(() => tagRuleFromOSMTag("x", "amenity=")).toThrow(/malformed osmTag/)
	expect(() => tagRuleFromOSMTag("x", "a=b=c")).toThrow(/malformed osmTag/)
})
