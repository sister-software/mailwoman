import {
	buildTelecomPOISQL,
	extractOSMPOIs,
	matchOSMPOITagRule,
	tagRuleFromOSMTag,
	TELECOM_TAG_RULES,
} from "@mailwoman/osm/sdk/extract/poi"
import { expect, test } from "vitest"

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
