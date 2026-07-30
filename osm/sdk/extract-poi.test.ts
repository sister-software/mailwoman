/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   No fixture PBF exists under `osm/` test fixtures, so per the task brief this locks the two pure
 *   seams instead: {@link matchOSMPOITagRule} (the AND/OR tag-rule matcher, over synthetic tag dicts)
 *   and {@link buildTelecomPOISQL} (the OGRSQL string builder). Neither spawns `ogr2ogr` — the actual
 *   `extractOSMPOIs` process-spawn integration is unexercised here and requires the build-local ladder
 *   (a real Geofabrik `.osm.pbf` + GDAL on the path); see the task report for a transcript verifying
 *   the SQL this module builds against a hand-authored `.osm` XML fixture with the system `ogr2ogr`.
 */

import { expect, test } from "vitest"

import { buildTelecomPOISQL, extractOSMPOIs, matchOSMPOITagRule, TELECOM_TAG_RULES } from "./extract-poi.ts"

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
	// both branches at once still resolves to the same category (first rule wins, harmlessly)
	expect(matchOSMPOITagRule({ man_made: "telephone_exchange", telecom: "exchange" })).toBe("telecom_exchange")
})

test("matchOSMPOITagRule: telecom_cabinet requires BOTH tags (AND, not OR)", () => {
	expect(matchOSMPOITagRule({ man_made: "street_cabinet", street_cabinet: "telecom" })).toBe("telecom_cabinet")
	// only one of the two conjuncts present -> no match
	expect(matchOSMPOITagRule({ man_made: "street_cabinet" })).toBeNull()
	expect(matchOSMPOITagRule({ street_cabinet: "telecom" })).toBeNull()
})

test("matchOSMPOITagRule: tower_comms requires BOTH man_made=mast AND tower:type=communication", () => {
	expect(matchOSMPOITagRule({ man_made: "mast", "tower:type": "communication" })).toBe("tower_comms")
	// a mast with no comms qualifier (e.g. a lighting mast) must not match
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
	// name + man_made are promoted OGR fields per GDAL's default osmconf.ini — bare column references.
	expect(sql).toContain("SELECT name,")
	expect(sql).toMatch(/\bman_made='telephone_exchange'/)
	expect(sql).toMatch(/\bman_made AS man_made\b/)
	// custom telecom tags aren't promoted — they're read out of the other_tags hstore.
	expect(sql).toContain(`hstore_get_value(other_tags,'telecom') AS telecom`)
	expect(sql).toContain(`hstore_get_value(other_tags,'street_cabinet') AS street_cabinet`)
	// tower:type's colon can't survive as a bare alias, so it's laundered.
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

test("buildTelecomPOISQL: honors a custom rule table (single OR-less rule, no hstore keys)", () => {
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
	const it = extractOSMPOIs("/nonexistent.pbf", hostileRules)

	await expect(it.next()).rejects.toThrow(/tag-token allowlist/)
})
