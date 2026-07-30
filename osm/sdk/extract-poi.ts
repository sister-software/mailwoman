/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Telecom-infrastructure POI extractor (BDC 2b task 2, decisions 2/3) — stream OSM telecom features
 *   (telephone exchanges, street cabinets, communications masts, data centers) out of a Geofabrik
 *   `.osm.pbf` extract via GDAL/ogr2ogr, matched against an AND/OR tag-rule table, and yielded as
 *   {@link POISourceRow}s ready for `buildPOIDatabase`'s injected `rows` seam
 *   (`mailwoman/gazetteer-pipeline/poi/build-poi.ts:341`) — DuckDB bypassed entirely (decision 3).
 *   Mirrors `extract.ts`'s process-spawn + GeoJSONSeq-over-stdout idiom exactly; the two differences
 *   are the predicate (telecom tags, not `addr:housenumber`) and the match fan-out (a feature can only
 *   satisfy the FIRST rule in table order, since no two rules here share a tag key).
 *
 *   Tag disjunctions/conjunctions live HERE, not in the taxonomy (decision 2): `CategoryRecord.osmTag`
 *   is a single scalar the Overpass emitter consumes (`poi-taxonomy/overpass.ts` hard-splits on one
 *   `=`), so an OR across two tags (telephone exchange) or an AND with a qualifier tag (street
 *   cabinet, comms mast) can't live there. {@link OSMPOITagRule.all} is a conjunction (AND) of
 *   `[key, value]` pairs; OR is expressed as multiple rules sharing a `categoryID` — see
 *   {@link TELECOM_TAG_RULES}.
 *
 *   Promoted vs. hstore tag columns: GDAL's default `osmconf.ini` (`/usr/share/gdal/osmconf.ini` on
 *   this box) promotes `name` and `man_made` to real OGR fields for BOTH the `points` and
 *   `multipolygons` layers this extractor queries — they're selected as bare columns. `telecom`,
 *   `street_cabinet`, and `tower:type` are NOT in either layer's `attributes=` list, so they land in
 *   the `other_tags` hstore and are read via `hstore_get_value`, exactly as `extract.ts` reads
 *   `addr:*`. This split was verified against the installed `osmconf.ini` and a hand-built `.osm` XML
 *   fixture (GDAL's OSM driver reads plain OSM XML the same way it reads `.pbf`) — see the report for
 *   the transcript. A custom `OSM_CONFIG_FILE` that un-promotes `man_made` would break the bare-column
 *   assumption; not a concern for the shipped default.
 *
 *   `POISourceRow` is declared LOCALLY here (structurally identical to the exported interface of the
 *   same name in `mailwoman/gazetteer-pipeline/poi/build-poi.ts`) rather than imported: `@mailwoman/osm`
 *   is a dependency OF the top-level `mailwoman` package (which owns the gazetteer pipeline), never the
 *   reverse — importing it here would invert the workspace dependency graph. Task 3 (the `--source osm`
 *   build branch, landing in `build-poi.ts`) sits on the correct side of that edge; TS structural typing
 *   accepts this row with no cast, so Task 3 wires the two together directly.
 *
 *   `country` has no representation on a bare OSM feature (a Geofabrik extract's country isn't a
 *   feature property) and this module's `extractOSMPOIs(pbfPath, rules?)` signature — fixed by the task
 *   brief — takes no `--country` parameter. Rows are yielded with `country: ""`; Task 3's `--source osm`
 *   build branch has the invocation's own `--country` flag and is expected to stamp it onto each row
 *   before the rows reach `buildPOIDatabase`.
 */

import { spawn } from "node:child_process"

import { TextSpliterator } from "spliterator"

/**
 * One Overture Places row, decoded to the flat shape `buildPOIDatabase`'s injected-rows seam consumes. Structurally
 * identical to `POISourceRow` in `mailwoman/gazetteer-pipeline/poi/build-poi.ts` — kept as a local copy per this
 * module's header docstring (dependency-direction note).
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
 * Telecom-infrastructure tag rules (decision 2), category ids matching `poi-taxonomy` exactly
 * (`telecom_exchange`/`tower_comms` landed in task 1; `telecom_cabinet`/`data_center` pre-existed):
 *
 * - `telecom_exchange` ← `man_made=telephone_exchange` OR `telecom=exchange`
 * - `telecom_cabinet` ← `man_made=street_cabinet` AND `street_cabinet=telecom`
 * - `tower_comms` ← `man_made=mast` AND `tower:type=communication`
 * - `data_center` ← `man_made=data_center` OR `telecom=data_center`
 *
 * Rule order only matters in that the FIRST matching rule wins per feature; since no two rules share a tag key, every
 * real-world feature can match at most one rule regardless of order.
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
 * The OSM driver layers that can carry telecom infrastructure: nodes and building-ish ways/relations. Mirrors
 * `extract.ts`'s `ADDR_LAYERS`.
 */
const POI_LAYERS = ["points", "multipolygons"] as const

/**
 * Tag keys GDAL's default `osmconf.ini` promotes to real OGR fields for both `points` and `multipolygons` — selected as
 * bare columns rather than via `hstore_get_value`. See the module docstring's "Promoted vs. hstore tag columns" note.
 */
const PROMOTED_KEYS = new Set(["name", "man_made"])

/**
 * OGRSQL column aliases can't contain `:` — launder it the same way GDAL's own `attribute_name_laundering` would
 * (`tower:type` -> `tower_type`).
 */
function tagAlias(key: string): string {
	return key.replaceAll(":", "_")
}

/**
 * The SQL expression reading a tag's value: a bare column for a {@link PROMOTED_KEYS} member, or an `other_tags` hstore
 * lookup otherwise.
 */
function tagSelectExpr(key: string): string {
	return PROMOTED_KEYS.has(key) ? key : `hstore_get_value(other_tags,'${key}')`
}

/**
 * Distinct tag keys referenced across a rule table's `all` conjunctions, in first-seen order, `name` excluded (it's
 * always selected separately as the row's display name, never a rule predicate here).
 */
function distinctTagKeys(rules: readonly OSMPOITagRule[]): string[] {
	const seen = new Set<string>()

	for (const rule of rules) {
		for (const [key] of rule.all) {
			if (key !== "name") {
				seen.add(key)
			}
		}
	}

	return [...seen]
}

/**
 * Build the OGRSQL SELECT+WHERE for one layer: an OR of the rule table's AND-groups over promoted-column/`other_tags`
 * tag values, projecting `name` plus every referenced key so {@link extractOSMPOIs} can re-derive the matched category
 * in JS via {@link matchOSMPOITagRule} — the belt to this predicate's suspenders. A GDAL OGRSQL dialect quirk could
 * only narrow, never widen, what this WHERE matches, and the JS-side matcher re-checks the same rule table before a row
 * is ever yielded, so no false positive can slip through even if the pushdown predicate were imprecise.
 */
export function buildTelecomPOISQL(layer: string, rules: readonly OSMPOITagRule[] = TELECOM_TAG_RULES): string {
	const tagCols = distinctTagKeys(rules).map((key) => `${tagSelectExpr(key)} AS ${tagAlias(key)}`)

	const whereGroups = rules.map(
		(rule) => "(" + rule.all.map(([key, value]) => `${tagSelectExpr(key)}='${value}'`).join(" AND ") + ")"
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

const isFinitePair = (lon: unknown, lat: unknown): boolean =>
	typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)

/**
 * Reduce a GeoJSON geometry to one representative coordinate: the point itself, or a ring-vertex average for a polygon.
 * Duplicated from `extract.ts` (not exported there) — see that module's comment for why a vertex average is an
 * acceptable rooftop-tier centroid.
 */
function representativePoint(
	geom: { type?: string; coordinates?: unknown } | null | undefined
): [number, number] | null {
	if (!geom) return null

	if (geom.type === "Point") {
		const c = geom.coordinates as [number, number]

		return isFinitePair(c?.[0], c?.[1]) ? [c[0], c[1]] : null
	}

	const ring = (
		geom.type === "Polygon"
			? (geom.coordinates as number[][][])?.[0]
			: geom.type === "MultiPolygon"
				? (geom.coordinates as number[][][][])?.[0]?.[0]
				: null
	) as number[][] | null

	if (!ring || !ring.length) return null

	let n = ring.length

	if (n > 1 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1]) {
		n--
	}

	let sx = 0
	let sy = 0

	for (let i = 0; i < n; i++) {
		sx += ring[i]![0]!
		sy += ring[i]![1]!
	}

	const lon = sx / n
	const lat = sy / n

	return isFinitePair(lon, lat) ? [lon, lat] : null
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
		// No feature-level country on a bare OSM extract — see the module docstring. Task 3's
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
	const tagKeys = distinctTagKeys(rules)
	const sql = buildTelecomPOISQL(layer, rules)
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", sql, pbfPath]
	const proc = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "pipe"] })
	let stderr = ""

	proc.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})

	const exit = new Promise<number>((resolve, reject) => {
		proc.on("error", reject)
		proc.on("close", resolve)
	})

	for await (const raw of TextSpliterator.fromAsync(proc.stdout)) {
		const line = raw.trim()

		if (!line) continue
		let feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }

		try {
			feature = JSON.parse(line)
		} catch {
			continue
		}

		const row = toPOISourceRow(feature, rules, tagKeys)

		if (row) {
			yield row
		}
	}

	const code = await exit

	if (code !== 0) throw new Error(`ogr2ogr (${layer}) exited ${code}: ${stderr.slice(-800)}`)
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
