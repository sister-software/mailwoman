/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Telecom-infrastructure POI extractor (decisions 2/3) — stream OSM telecom features
 *   (telephone exchanges, street cabinets, communications masts, data centers) out of a Geofabrik
 *   `.osm.pbf` extract via gdal/ogr2ogr. The extractor matches features against an and/or tag-rule table and yields
 *   {@link POISourceRow}s ready for `buildPOIDatabase`'s injected `rows` point
 *   (`mailwoman/gazetteer-pipeline/poi/build-poi.ts:341`) — DuckDB bypassed entirely (decision 3).
 *   Mirrors `extract.ts`'s process-spawn + GeoJSONSeq-over-stdout idiom exactly. the two differences
 *   are the predicate (telecom tags rather than `addr:housenumber`) and the match fan-out (a feature can only
 *   satisfy the first rule in table order — `man_made` appears as a key in four rules and `telecom` in
 *   two. Every rule sharing a key requires a different value, so a real feature
 *   has one value per key, can satisfy at most one rule regardless of table order).
 *
 *   Tag disjunctions/conjunctions live here rather than in the taxonomy (decision 2): `CategoryRecord.osmTag`
 *   is a single scalar the Overpass emitter consumes (`poi-taxonomy/overpass.ts` hard-splits on one
 *   `=`), so a disjunction across two tags (telephone exchange) or a conjunction with a qualifier tag
 *   (street cabinet, comms mast) can't live there. {@link OSMPOITagRule.all} is a conjunction of
 *   `[key, value]` pairs. a disjunction is expressed as multiple rules sharing a `categoryID` — see
 *   {@link TELECOM_TAG_RULES}.
 *
 *   Promoted vs. hstore tag columns: gdal's default `osmconf.ini` (`/usr/share/gdal/osmconf.ini` on
 *   this box) promotes a different key list per layer to real OGR fields — selected as bare columns —
 *   and drops each promoted key from that layer's `other_tags` hstore. `name` and `man_made` are on
 *   both lists; `amenity`, `shop` and `building` are on `multipolygons` only. Keys on neither list
 *   (`telecom`, `street_cabinet`, `tower:type`) are read via `hstore_get_value`, exactly as
 *   `extract.ts` reads `addr:*`. {@link PROMOTED_KEYS_BY_LAYER} stores both lists, because reading a
 *   promoted key through `hstore_get_value` returns NULL for every feature of that layer — a silent
 *   empty result rather than an error. A custom `OSM_CONFIG_FILE` that un-promotes a key on either
 *   list would break the bare-column assumption. not a concern for the shipped default.
 *
 *   `POISourceRow` is declared here and the `mailwoman` gazetteer pipeline imports it: `@mailwoman/osm`
 *   is a dependency OF the top-level `mailwoman` package, never the reverse, so this side of the edge
 *   is the row's one home.
 *
 *   `country` has no representation on a bare OSM feature (a Geofabrik extract's country isn't a
 *   feature property) and this module's `extractOSMPOIs(pbfPath, rules?)` signature takes no
 *   `--country` parameter. Rows are yielded with `country: ""`; the `--source osm`
 *   build branch has the invocation's own `--country` flag and is expected to stamp it onto each row
 *   before the rows reach `buildPOIDatabase`.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr/stream"

import { representativePoint } from "#sdk/representative-point"
import {
	assertSafeTagRules,
	distinctTagKeys,
	type PromotedKeysByLayer,
	tagAlias,
	tagSelectExpr,
} from "#sdk/tag-columns"

/**
 * One POI row in the flat shape `mailwoman`'s `buildPOIDatabase` loads,
 * decoded here from an Overture Places or OSM feature.
 */
export interface POISourceRow {
	name: string | null
	category: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	gersID: string | null
}

/**
 * One telecom-category match rule: `categoryID` wins when every `[key, value]` pair
 * in `all` is present on the feature (a conjunction within a rule).
 *
 * A disjunction across tags is expressed as multiple rules sharing a `categoryID`.
 * See {@link TELECOM_TAG_RULES}'s two `telecom_exchange` rules and two `data_center` rules.
 */
export interface OSMPOITagRule {
	categoryID: string
	all: Array<[key: string, value: string]>
}

/**
 * Telecom-infrastructure tag rules (decision 2), category ids matching `poi-taxonomy` exactly:
 *
 * - `telecom_exchange` ← `man_made=telephone_exchange` or `telecom=exchange`
 * - `telecom_cabinet` ← `man_made=street_cabinet` and `street_cabinet=telecom`
 * - `tower_comms` ← `man_made=mast` and `tower:type=communication`
 * - `data_center` ← `man_made=data_center` or `telecom=data_center`
 *
 * Rule order only matters in that the first matching rule wins per feature;
 * `man_made` appears as a key in four rules and `telecom` in two, but every rule
 * sharing a key requires a different value for it, so a real-world feature —
 * which has one value per key — can match at most one rule regardless of order.
 */
export const TELECOM_TAG_RULES: OSMPOITagRule[] = [
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
]

/**
 * The rail stations a `駅` or `Station` query names, under Overture's station categories
 * so a layer built from either source reads the same.
 *
 * The subway and light-rail rules come before the plain station rule, because a feature
 * matches the first rule it satisfies and a subway station also has `railway=station`.
 */
export const STATION_TAG_RULES: OSMPOITagRule[] = [
	{
		categoryID: "metro_station",
		all: [
			["railway", "station"],
			["station", "subway"],
		],
	},
	{
		categoryID: "light_rail_and_subway_station",
		all: [
			["railway", "station"],
			["station", "light_rail"],
		],
	},
	{ categoryID: "train_station", all: [["railway", "station"]] },
	{ categoryID: "train_station", all: [["railway", "halt"]] },
]

/**
 * A rule table plus the names each matched feature is written under.
 */
export interface OSMPOIRuleSet {
	rules: OSMPOITagRule[]
	/**
	 * Tag keys the names read beyond the rule keys, such as `name:en`.
	 */
	nameKeys?: readonly string[]
	/**
	 * The strings a matched feature is written under, one row each, read from its tags and `name`.
	 *
	 * @defaultValue The feature's `name`.
	 */
	names?: (tags: Readonly<Record<string, string | undefined>>) => string[]
	/**
	 * Merges the rows of one real-world feature that OSM maps as several, run over the whole extract.
	 */
	merge?: (rows: readonly POISourceRow[]) => POISourceRow[]
}

/**
 * The distance within which two same-name station rows are one station.
 *
 * OSM maps a large station as one node per operator.
 * Shibuya Station is five `渋谷` nodes up to 300 m apart, so one station would otherwise
 * read as five entities that no exact-name probe can choose between.
 *
 * In the Japan extract of 2026-08-05, 1,687 of 3,848 same-name pairs lie within 500 m,
 * 69 within 500 m–1 km, 58 within 1–20 km and 2,034 beyond 20 km, so 1 km merges a
 * station's nodes and keeps two stations of one name apart.
 */
export const STATION_COMPLEX_M = 1000

/**
 * Merges same-name rows lying within {@linkcode STATION_COMPLEX_M} of one another
 * (single link) into the row with the least summed distance to the rest of its group.
 *
 * The categories of one complex merge too: Shinjuku's rail and subway nodes are one station to a query.
 * The kept row's category stands for the complex.
 */
export function mergeStationComplexes(rows: readonly POISourceRow[]): POISourceRow[] {
	const groups = new Map<string, POISourceRow[]>()

	for (const row of rows) {
		const key = row.name ?? ""
		groups.set(key, [...(groups.get(key) ?? []), row])
	}

	const merged: POISourceRow[] = []

	const meters = (a: POISourceRow, b: POISourceRow) =>
		haversine(a.latitude, a.longitude, b.latitude, b.longitude) * 1000

	for (const group of groups.values()) {
		const seen = new Set<number>()

		for (let i = 0; i < group.length; i++) {
			if (seen.has(i)) continue

			const cluster = [i]
			seen.add(i)

			// The loop visits every index pushed during it.
			// This computes the single-link closure.
			for (const member of cluster) {
				for (let j = 0; j < group.length; j++) {
					if (!seen.has(j) && meters(group[member]!, group[j]!) <= STATION_COMPLEX_M) {
						seen.add(j)
						cluster.push(j)
					}
				}
			}

			const members = cluster.map((index) => group[index]!)

			let best = members[0]!
			let bestCost = Number.POSITIVE_INFINITY

			for (const candidate of members) {
				let cost = 0

				for (const other of members) {
					cost += meters(candidate, other)
				}

				if (cost < bestCost) {
					best = candidate
					bestCost = cost
				}
			}

			merged.push(best)
		}
	}

	return merged
}

/**
 * The word each language appends to a station's name, keyed by the OSM `name:<language>` tag.
 *
 * OSM labels a station with its place's name (`name=渋谷`, `name:en=Shibuya`).
 * A query writes the station word as well (`渋谷駅`, `Shibuya Station`).
 */
export const STATION_WORDS: Readonly<Record<string, string>> = {
	"name:ja": "駅",
	"name:ko": "역",
	"name:zh": "站",
	"name:en": " Station",
}

/**
 * The strings a station is queried under: each `name:<language>` tag in
 * {@linkcode STATION_WORDS} followed by that language's station word.
 *
 * A name that already ends in the word keeps it once.
 */
export function stationNames(tags: Readonly<Record<string, string | undefined>>): string[] {
	const names = new Set<string>()

	for (const [key, word] of Object.entries(STATION_WORDS)) {
		const value = tags[key]?.trim()

		if (!value) continue

		names.add(value.endsWith(word.trim()) ? value : `${value}${word}`)
	}

	return [...names]
}

/**
 * The rule sets the `--source osm` build selects by name.
 */
export const OSM_POI_RULE_SETS: Readonly<Record<string, OSMPOIRuleSet>> = {
	telecom: { rules: TELECOM_TAG_RULES },
	stations: {
		rules: STATION_TAG_RULES,
		nameKeys: Object.keys(STATION_WORDS),
		names: stationNames,
		merge: mergeStationComplexes,
	},
}

/**
 * Turn a taxonomy record's scalar `osmTag` (`amenity=pharmacy`) into a single-conjunct rule table entry.
 *
 * Hard-splits on one `=`, the same reading `poi-taxonomy/overpass.ts` gives the field,
 * so a category extracted here and the Overpass query emitted for it cannot come
 * to disagree about what the category means.
 */
export function tagRuleFromOSMTag(categoryID: string, osmTag: string): OSMPOITagRule {
	const parts = osmTag.split("=")

	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`tagRuleFromOSMTag: malformed osmTag ${stringifyJSON(osmTag)} — expected key=value`)
	}

	return { categoryID, all: [[parts[0], parts[1]]] }
}

/**
 * The OSM driver layers that can contain telecom infrastructure: nodes and building-ish ways/relations.
 *
 * Mirrors `extract.ts`'s `ADDR_LAYERS`.
 */
const POI_LAYERS = ["points", "multipolygons"] as const

/**
 * Tag keys gdal's default `osmconf.ini` promotes to real OGR fields, PER layer —
 * selected as bare columns rather than via `hstore_get_value`.
 *
 * See the module docstring's "Promoted vs. hstore tag columns" note.
 *
 * The two lists differ.
 * A promoted key is removed from `other_tags`, so reading it with `hstore_get_value`
 * on a layer that promotes it returns NULL for every feature — a whole layer of
 * real matches reported as an empty result.
 *
 * Measured on the Île-de-France extract with `amenity=pharmacy`
 * (promoted on `multipolygons`, hstore on `points`): the hstore expression answered 0
 * on `multipolygons` where the bare column answered 178, against 3,130 from `points` —
 * 5.4% of the class silently absent, in the direction that inflates a completeness estimate.
 */
const PROMOTED_KEYS_BY_LAYER: PromotedKeysByLayer = {
	points: new Set(["name", "barrier", "highway", "ref", "address", "is_in", "place", "man_made"]),
	multipolygons: new Set([
		"name",
		"type",
		"aeroway",
		"amenity",
		"admin_level",
		"barrier",
		"boundary",
		"building",
		"craft",
		"geological",
		"historic",
		"land_area",
		"landuse",
		"leisure",
		"man_made",
		"military",
		"natural",
		"office",
		"place",
		"shop",
		"sport",
		"tourism",
	]),
}

/**
 * The shared {@link distinctTagKeys} minus `name` — always selected separately as
 * the row's display name, never a rule predicate here.
 */
function distinctPredicateKeys(rules: readonly OSMPOITagRule[]): string[] {
	return distinctTagKeys(rules).filter((key) => key !== "name")
}

/**
 * Build the ogrsql select+where for one layer: an `or` of the rule table's and-groups over
 * promoted-column/`other_tags` tag values, projecting `name` plus every referenced key
 * so {@link extractOSMPOIs} can re-derive the matched category in JS via
 * {@link matchOSMPOITagRule} — the belt to this predicate's suspenders.
 *
 * A GDAL OGRSQL dialect quirk can only narrow the rows matched by this WHERE clause.
 * The JavaScript matcher checks the same rule table before yielding a row.
 *
 * That check rejects false positives even when the pushdown predicate is imprecise.
 *
 * @throws via {@link assertSafeTagRules} if `rules` contains a key/value
 * outside the OSM tag-token allowlist.
 * `rules` is a public, caller-suppliable parameter, so this validates before any interpolation
 * rather than trusting the hardcoded default table's shape.
 */
export function buildTelecomPOISQL(
	layer: string,
	rules: readonly OSMPOITagRule[] = TELECOM_TAG_RULES,
	extraKeys: readonly string[] = []
): string {
	assertSafeTagRules(rules, "buildTelecomPOISQL")
	assertSafeTagRules([{ all: extraKeys.map((key): [string, string] => [key, "x"]) }], "buildTelecomPOISQL")

	const keys = [...new Set([...distinctPredicateKeys(rules), ...extraKeys])]

	const tagCols = keys.map((key) => `${tagSelectExpr(PROMOTED_KEYS_BY_LAYER, layer, key)} AS ${tagAlias(key)}`)

	const whereGroups = rules.map(
		(rule) =>
			"(" +
			rule.all.map(([key, value]) => `${tagSelectExpr(PROMOTED_KEYS_BY_LAYER, layer, key)}='${value}'`).join(" AND ") +
			")"
	)

	return `SELECT name, ${tagCols.join(", ")} FROM ${layer} WHERE ${whereGroups.join(" OR ")}`
}

/**
 * Pure tag-rule matcher (decision 2): the first rule whose `all` conjunction is
 * fully satisfied by `tags` wins, `null` when none match.
 *
 * `tags` is a plain key -> value dict (a decoded feature's promoted-column/`other_tags` values).
 * No OGR/ogr2ogr involved, so unit tests can use synthetic dictionaries.
 */
export function matchOSMPOITagRule(
	tags: Readonly<Record<string, string | undefined>>,
	rules: readonly OSMPOITagRule[] = TELECOM_TAG_RULES
): string | null {
	for (const rule of rules) {
		if (rule.all.every(([key, value]) => tags[key] === value)) {
			return rule.categoryID
		}
	}

	return null
}

/**
 * Decode one ogr2ogr GeoJSONSeq feature into one {@link POISourceRow} per name the rule set writes it
 * under, or none when it satisfies none of the rules (the JS-side re-check) or has no usable geometry.
 */
export function toPOISourceRows(
	feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } },
	ruleSet: OSMPOIRuleSet,
	tagKeys: readonly string[]
): POISourceRow[] {
	const p = feature.properties ?? {}
	const tags: Record<string, string | undefined> = {}

	for (const key of tagKeys) {
		const raw = p[tagAlias(key)]

		tags[key] = raw != null && raw !== "" ? String(raw) : undefined
	}

	const categoryID = matchOSMPOITagRule(tags, ruleSet.rules)

	if (!categoryID) return []

	const pt = representativePoint(feature.geometry ?? null)

	if (!pt) return []

	const rawName = p["name"]
	const name = rawName != null && rawName !== "" ? String(rawName) : undefined
	const names = ruleSet.names ? ruleSet.names({ ...tags, name }) : [name ?? null]

	return names.map((written) => ({
		name: written,
		category: categoryID,
		brandWikidata: null,
		longitude: pt[0],
		latitude: pt[1],
		// No feature-level country on a bare OSM extract — see the module docstring.
		// The `--source osm` build branch stamps the invocation's `--country` onto each row.
		country: "",
		confidence: 1,
		gersID: null,
	}))
}

/**
 * Run ogr2ogr against one layer, yielding matched {@link POISourceRow}s from its GeoJSONSeq stdout.
 *
 * Mirrors `extract.ts`'s `runLayer` process-spawn/stderr-capture/exit-code idiom exactly.
 */
async function* runPOILayer(pbfPath: string, layer: string, ruleSet: OSMPOIRuleSet): AsyncGenerator<POISourceRow> {
	const nameKeys = ruleSet.nameKeys ?? []
	const tagKeys = [...new Set([...distinctPredicateKeys(ruleSet.rules), ...nameKeys])]
	const sql = buildTelecomPOISQL(layer, ruleSet.rules, nameKeys)
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", sql, pbfPath]

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: Record<string, unknown>
		geometry?: { type?: string; coordinates?: unknown }
	}>(args, `osm poi (${layer})`)) {
		yield* toPOISourceRows(feature, ruleSet, tagKeys)
	}
}

/**
 * Stream every feature matching a rule set from a PBF extract's `points` + `multipolygons`
 * layers, geometry reduced to a representative coordinate (centroid for polygons).
 *
 * `confidence` is fixed at `1` and `gersID`/`brandWikidata` are always `null` — OSM rows have neither.
 * See the module docstring for the `country` caveat.
 *
 * @param rules [{@linkcode TELECOM_TAG_RULES}] The tag rules a feature must satisfy,
 * or a rule set with its names.
 */
export async function* extractOSMPOIs(
	pbfPath: string,
	rules: OSMPOITagRule[] | OSMPOIRuleSet = TELECOM_TAG_RULES
): AsyncIterable<POISourceRow> {
	const ruleSet = Array.isArray(rules) ? { rules } : rules

	for (const layer of POI_LAYERS) {
		yield* runPOILayer(pbfPath, layer, ruleSet)
	}
}
