/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Telecom-infrastructure POI extractor (decisions 2/3) — stream OSM telecom features
 *   (telephone exchanges, street cabinets, communications masts, data centers) out of a Geofabrik
 *   `.osm.pbf` extract via GDAL/ogr2ogr, matched against an AND/OR tag-rule table, and yielded as
 *   {@link POISourceRow}s ready for `buildPOIDatabase`'s injected `rows` point
 *   (`mailwoman/gazetteer-pipeline/poi/build-poi.ts:341`) — DuckDB bypassed entirely (decision 3).
 *   Mirrors `extract.ts`'s process-spawn + GeoJSONSeq-over-stdout idiom exactly; the two differences
 *   are the predicate (telecom tags, not `addr:housenumber`) and the match fan-out (a feature can only
 *   satisfy the FIRST rule in table order — `man_made` alone appears in four rules and `telecom` in
 *   two, but every rule sharing a key requires a DIFFERENT value for it, so a real feature, which
 *   carries one value per key, can satisfy at most one rule regardless of table order).
 *
 *   Tag disjunctions/conjunctions live HERE, not in the taxonomy (decision 2): `CategoryRecord.osmTag`
 *   is a single scalar the Overpass emitter consumes (`poi-taxonomy/overpass.ts` hard-splits on one
 *   `=`), so an OR across two tags (telephone exchange) or an AND with a qualifier tag (street
 *   cabinet, comms mast) can't live there. {@link OSMPOITagRule.all} is a conjunction (AND) of
 *   `[key, value]` pairs; OR is expressed as multiple rules sharing a `categoryID` — see
 *   {@link TELECOM_TAG_RULES}.
 *
 *   Promoted vs. hstore tag columns: GDAL's default `osmconf.ini` (`/usr/share/gdal/osmconf.ini` on
 *   this box) promotes a DIFFERENT key list per layer to real OGR fields — selected as bare columns —
 *   and drops each promoted key from that layer's `other_tags` hstore. `name` and `man_made` are on
 *   both lists; `amenity`, `shop` and `building` are on `multipolygons` only. Keys on neither list
 *   (`telecom`, `street_cabinet`, `tower:type`) are read via `hstore_get_value`, exactly as
 *   `extract.ts` reads `addr:*`. {@link PROMOTED_KEYS_BY_LAYER} carries both lists, because reading a
 *   promoted key through `hstore_get_value` returns NULL for every feature of that layer — a silent
 *   empty result rather than an error. A custom `OSM_CONFIG_FILE` that un-promotes a key on either
 *   list would break the bare-column assumption; not a concern for the shipped default.
 *
 *   `POISourceRow` is declared LOCALLY here (structurally identical to the exported interface of the
 *   same name in `mailwoman/gazetteer-pipeline/poi/build-poi.ts`) rather than imported: `@mailwoman/osm`
 *   is a dependency OF the top-level `mailwoman` package (which owns the gazetteer pipeline), never the
 *   reverse — importing it here would invert the workspace dependency graph. `build-poi.ts`'s `--source osm`
 *   build branch sits on the correct side of that edge; TS structural typing
 *   accepts this row with no cast, so the two are wired together directly.
 *
 *   `country` has no representation on a bare OSM feature (a Geofabrik extract's country isn't a
 *   feature property) and this module's `extractOSMPOIs(pbfPath, rules?)` signature takes no
 *   `--country` parameter. Rows are yielded with `country: ""`; the `--source osm`
 *   build branch has the invocation's own `--country` flag and is expected to stamp it onto each row
 *   before the rows reach `buildPOIDatabase`.
 */

import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"

import { representativePoint } from "#sdk/representative-point"
import {
	assertSafeTagRules,
	distinctTagKeys,
	type PromotedKeysByLayer,
	tagAlias,
	tagSelectExpr,
} from "#sdk/tag-columns"

/**
 * One Overture Places row, decoded to the flat shape `buildPOIDatabase`'s injected-rows injection point consumes.
 * Structurally identical to `POISourceRow` in `mailwoman/gazetteer-pipeline/poi/build-poi.ts` — kept as a local copy
 * per this module's header docstring (dependency-direction note).
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
 * One telecom-category match rule: `categoryID` wins when EVERY `[key, value]` pair in `all` is present on the feature
 * (AND within a rule). OR across tags is expressed as multiple rules sharing the same `categoryID` — see
 * {@link TELECOM_TAG_RULES}'s two `telecom_exchange` rules and two `data_center` rules.
 */
export interface OSMPOITagRule {
	categoryID: string
	all: Array<[key: string, value: string]>
}

/**
 * Telecom-infrastructure tag rules (decision 2), category ids matching `poi-taxonomy` exactly:
 *
 * - `telecom_exchange` ← `man_made=telephone_exchange` OR `telecom=exchange`
 * - `telecom_cabinet` ← `man_made=street_cabinet` AND `street_cabinet=telecom`
 * - `tower_comms` ← `man_made=mast` AND `tower:type=communication`
 * - `data_center` ← `man_made=data_center` OR `telecom=data_center`
 *
 * Rule order only matters in that the FIRST matching rule wins per feature; `man_made` alone appears in four rules and
 * `telecom` in two, but every rule sharing a key requires a different value for it, so a real-world feature — which
 * carries one value per key — can match at most one rule regardless of order.
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
 * Turn a taxonomy record's scalar `osmTag` (`amenity=pharmacy`) into a single-conjunct rule table entry.
 *
 * Hard-splits on one `=`, the same reading `poi-taxonomy/overpass.ts` gives the field, so a category extracted here and
 * the Overpass query emitted for it cannot come to disagree about what the category means.
 */
export function tagRuleFromOSMTag(categoryID: string, osmTag: string): OSMPOITagRule {
	const parts = osmTag.split("=")

	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`tagRuleFromOSMTag: malformed osmTag ${JSON.stringify(osmTag)} — expected key=value`)
	}

	return { categoryID, all: [[parts[0], parts[1]]] }
}

/**
 * The OSM driver layers that can carry telecom infrastructure: nodes and building-ish ways/relations. Mirrors
 * `extract.ts`'s `ADDR_LAYERS`.
 */
const POI_LAYERS = ["points", "multipolygons"] as const

/**
 * Tag keys GDAL's default `osmconf.ini` promotes to real OGR fields, PER LAYER — selected as bare columns rather than
 * via `hstore_get_value`. See the module docstring's "Promoted vs. hstore tag columns" note.
 *
 * The two lists differ, and the difference is not cosmetic: a promoted key is REMOVED from `other_tags`, so reading it
 * with `hstore_get_value` on a layer that promotes it returns NULL for every feature — a whole layer of real matches
 * reported as an empty result. Measured on the Île-de-France extract with `amenity=pharmacy` (promoted on
 * `multipolygons`, hstore on `points`): the hstore expression answered 0 on `multipolygons` where the bare column
 * answered 178, against 3,130 from `points` — 5.4% of the class silently absent, in the direction that inflates a
 * completeness estimate.
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
 * The shared {@link distinctTagKeys} minus `name` — always selected separately as the row's display name, never a rule
 * predicate here.
 */
function distinctPredicateKeys(rules: readonly OSMPOITagRule[]): string[] {
	return distinctTagKeys(rules).filter((key) => key !== "name")
}

/**
 * Build the OGRSQL SELECT+WHERE for one layer: an OR of the rule table's AND-groups over promoted-column/`other_tags`
 * tag values, projecting `name` plus every referenced key so {@link extractOSMPOIs} can re-derive the matched category
 * in JS via {@link matchOSMPOITagRule} — the belt to this predicate's suspenders. A GDAL OGRSQL dialect quirk could
 * only narrow, never widen, what this WHERE matches, and the JS-side matcher re-checks the same rule table before a row
 * is ever yielded, so no false positive can slip through even if the pushdown predicate were imprecise.
 *
 * Throws via {@link assertSafeTagRules} if `rules` contains a key/value outside the OSM tag-token allowlist — `rules`
 * is a public, caller-suppliable parameter, so this validates before any interpolation rather than trusting the
 * hardcoded default table's shape.
 */
export function buildTelecomPOISQL(layer: string, rules: readonly OSMPOITagRule[] = TELECOM_TAG_RULES): string {
	assertSafeTagRules(rules, "buildTelecomPOISQL")

	const tagCols = distinctPredicateKeys(rules).map(
		(key) => `${tagSelectExpr(PROMOTED_KEYS_BY_LAYER, layer, key)} AS ${tagAlias(key)}`
	)

	const whereGroups = rules.map(
		(rule) =>
			"(" +
			rule.all.map(([key, value]) => `${tagSelectExpr(PROMOTED_KEYS_BY_LAYER, layer, key)}='${value}'`).join(" AND ") +
			")"
	)

	return `SELECT name, ${tagCols.join(", ")} FROM ${layer} WHERE ${whereGroups.join(" OR ")}`
}

/**
 * PURE tag-rule matcher (decision 2): the FIRST rule whose `all` conjunction is fully satisfied by `tags` wins, `null`
 * when none match. `tags` is a plain key -> value dict (a decoded feature's promoted-column/`other_tags` values) — no
 * OGR/ogr2ogr involved, so this is unit-testable over synthetic dicts alone.
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
 * Decode one ogr2ogr GeoJSONSeq feature into a {@link POISourceRow}, or `null` when it satisfies none of `rules` (the
 * JS-side re-check) or carries no usable geometry.
 */
function toPOISourceRow(
	feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } },
	rules: readonly OSMPOITagRule[],
	tagKeys: readonly string[]
): POISourceRow | null {
	const p = feature.properties ?? {}
	const tags: Record<string, string | undefined> = {}

	for (const key of tagKeys) {
		const raw = p[tagAlias(key)]

		tags[key] = raw != null && raw !== "" ? String(raw) : undefined
	}

	const categoryID = matchOSMPOITagRule(tags, rules)

	if (!categoryID) return null

	const pt = representativePoint(feature.geometry)

	if (!pt) return null

	const name = p["name"]

	return {
		name: name != null && name !== "" ? String(name) : null,
		category: categoryID,
		brandWikidata: null,
		longitude: pt[0],
		latitude: pt[1],
		// No feature-level country on a bare OSM extract — see the module docstring. The
		// `--source osm` build branch stamps the invocation's `--country` onto each row.
		country: "",
		confidence: 1,
		gersID: null,
	}
}

/**
 * Run ogr2ogr against one layer, yielding matched {@link POISourceRow}s from its GeoJSONSeq stdout. Mirrors
 * `extract.ts`'s `runLayer` process-spawn/stderr-capture/exit-code idiom exactly.
 */
async function* runPOILayer(
	pbfPath: string,
	layer: string,
	rules: readonly OSMPOITagRule[]
): AsyncGenerator<POISourceRow> {
	const tagKeys = distinctPredicateKeys(rules)
	const sql = buildTelecomPOISQL(layer, rules)
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", sql, pbfPath]

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: Record<string, unknown>
		geometry?: { type?: string; coordinates?: unknown }
	}>(args, `osm poi (${layer})`)) {
		const row = toPOISourceRow(feature, rules, tagKeys)

		if (row) {
			yield row
		}
	}
}

/**
 * Stream every telecom-infrastructure feature matching `rules` (default {@link TELECOM_TAG_RULES}) from a PBF extract's
 * `points` + `multipolygons` layers, geometry reduced to a representative coordinate (centroid for polygons).
 * `confidence` is fixed at `1` and `gersID`/`brandWikidata` are always `null` — OSM rows carry neither. See the module
 * docstring for the `country` caveat.
 */
export async function* extractOSMPOIs(
	pbfPath: string,
	rules: OSMPOITagRule[] = TELECOM_TAG_RULES
): AsyncIterable<POISourceRow> {
	for (const layer of POI_LAYERS) {
		yield* runPOILayer(pbfPath, layer, rules)
	}
}
