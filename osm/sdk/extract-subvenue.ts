/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Sub-venue structure extractor (#35 wave 1) — stream the venue-INTERIOR features (airport
 *   terminals, boarding gates, station platforms) and their containing venues (aerodromes, stations,
 *   campuses) out of a Geofabrik `.osm.pbf` extract via GDAL/ogr2ogr, matched against an AND/OR
 *   tag-rule table and yielded as {@link SubVenueSourceRow}s. Mirrors `extract-poi.ts`'s
 *   process-spawn + GeoJSONSeq-over-stdout idiom; the two differences are the predicate (transport
 *   structure, not telecom infrastructure) and the LOCALIZED-NAME harvest described below.
 *
 *   WHY THIS EXISTS. `docs/engineering/sub-venue-corpus-task.mdx` establishes that `North Terminal` /
 *   `Upper Concourse` fail to parse because the `unit` tag was never TAUGHT the modifier+designator
 *   shape, not because a decode weight is too low — closing it by weight would need a bias scale near
 *   11 nats against the 6.0 the stronger designator+identifier evidence needed. The fix is corpus, and
 *   the densest real source of sub-venue naming in existence is airport and rail terminal data. OSM's
 *   `aeroway` key is already the provenance for `terminal` and `gate` in
 *   `neural/venue-structure.ts`'s designator vocabulary, so this extends a source we already reach
 *   rather than adding a dependency.
 *
 *   ── THE LOCALIZED-NAME HARVEST, and why `other_tags` is selected wholesale ─────────────────────────
 *   `extract-poi.ts` enumerates the tag keys it needs and reads each through `hstore_get_value`. That
 *   cannot work here: the payload this extractor exists for is the `name:<lang>` FAMILY, whose key set
 *   is unbounded (OSM carries `name:ja`, `name:es`, `name:zh-Hant`, …). So the whole `other_tags`
 *   hstore is selected as one column and parsed in JS ({@link parseOSMHstore}), which yields every
 *   localized name a feature carries at no extra query cost. `Terminal Sur`, `ターミナル5`,
 *   `Nordterminal` all arrive this way — the non-English designator surfaces the corpus task calls the
 *   cheapest route to.
 *
 *   ── Promoted vs. hstore tag columns, and why the split is PER-LAYER here ──────────────────────────
 *   GDAL's default `osmconf.ini` (`/usr/share/gdal/osmconf.ini`, GDAL 3.8.4 on this box) promotes a
 *   DIFFERENT attribute list per layer, and the two keys this extractor leans on fall on opposite sides
 *   of that split:
 *
 *   - `aeroway` is promoted on `multipolygons` but NOT on `points`.
 *   - `ref` is promoted on `points` but NOT on `multipolygons`.
 *
 *   `extract-poi.ts` gets away with one layer-independent `PROMOTED_KEYS` set because `name` and
 *   `man_made` happen to be promoted on both. That would be wrong here, so {@link PROMOTED_KEYS_BY_LAYER}
 *   is keyed by layer. Verified against the installed `osmconf.ini` and against a hand-authored `.osm`
 *   XML fixture read with the system `ogr2ogr` (GDAL's OSM driver reads plain OSM XML the same way it
 *   reads `.pbf`), which is also what `extract-subvenue.test.ts` pins. A custom `OSM_CONFIG_FILE` that
 *   changes either `attributes=` line breaks the bare-column assumption; not a concern for the shipped
 *   default.
 *
 *   A promoted key is NOT repeated inside `other_tags` — that is the whole point of promotion — so the
 *   JS-side re-check reads promoted keys off the feature's own properties and everything else out of
 *   the parsed hstore. {@link toSubVenueSourceRow} merges the two before matching.
 *
 *   ── What this does NOT do ────────────────────────────────────────────────────────────────────────
 *   No parent linkage. A terminal's containing aerodrome is expressed in OSM by geometry (or an
 *   occasional site relation), not by a parent id, so pairing `Terminal 5` with `Heathrow Airport`
 *   needs a spatial join this module deliberately does not attempt. Both tiers are yielded with their
 *   coordinates and a {@link SubVenueTier} discriminator; pairing is the consumer's job.
 *
 *   No `country` either, for the same reason `extract-poi.ts` has none: a Geofabrik extract's country
 *   is a property of the invocation, not of a feature. Rows carry `country: ""` and the caller stamps it.
 */

import { spawn } from "node:child_process"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { TextSpliterator } from "spliterator"

/**
 * Which side of the containment relation a matched feature sits on.
 *
 * The corpus line this feeds is `<sub-venue>, <venue>, <street>, <locality>, <postcode>` — two DIFFERENT tags (`unit`
 * and `venue`), so a row has to say which one it is. `Terminal 5` is a {@link SubVenueTier.SubVenue}; `Heathrow
 * Airport` is a {@link SubVenueTier.Venue}.
 */
export const SubVenueTier = {
	/**
	 * A venue-interior structure — the `unit` side. Terminals, gates, platforms.
	 */
	SubVenue: "subvenue",
	/**
	 * The containing venue — the `venue` side. Aerodromes, stations, campuses.
	 */
	Venue: "venue",
} as const

export type SubVenueTier = (typeof SubVenueTier)[keyof typeof SubVenueTier]

/**
 * One match rule: `designatorID` wins when EVERY `[key, value]` pair in `all` is present on the feature (AND within a
 * rule). OR across tags is expressed as multiple rules sharing a `designatorID` — see {@link SUBVENUE_TAG_RULES}'s two
 * `platform` rules and two `station` rules.
 */
export interface SubVenueTagRule {
	/**
	 * The designator this rule attests, lowercased and in the same vocabulary as `neural/venue-structure.ts`'s
	 * `VENUE_STRUCTURE_DESIGNATORS` where the two overlap (`terminal`, `gate`, `campus`).
	 */
	designatorID: string
	tier: SubVenueTier
	all: Array<[key: string, value: string]>
}

/**
 * The tag rules, ordered — the FIRST rule a feature satisfies wins.
 *
 * Order is load-bearing in exactly one place: a station platform commonly carries BOTH `public_transport=platform` and
 * `railway=platform`, and an aerodrome terminal building sometimes carries both `aeroway=terminal` and
 * `building=terminal`. In every such case the colliding rules share a `designatorID`, so the first-wins resolution is
 * harmless — it picks the same answer either way. There is no pair of rules with DIFFERENT designators that a single
 * real feature can satisfy, because each pair requires a different value for a key a feature carries once.
 *
 * PROVENANCE, per rule, all documented OSM tags:
 *
 * - `aeroway=terminal` / `aeroway=gate` — the two `OSM_AEROWAY_STRUCTURE_DESIGNATORS` already in the span proposer's
 *   vocabulary. This is the class that motivated the whole arc.
 * - `building=terminal` — the building-classification equivalent, used where the terminal is mapped as a building rather
 *   than an aeroway feature.
 * - `public_transport=platform` / `railway=platform` — the rail equivalent. The corpus task asks for both aviation and
 *   rail specifically because their naming conventions differ (`Concourse B` vs `Platform 3`).
 * - `aeroway=aerodrome`, `railway=station`, `public_transport=station` — the containing venues.
 * - `amenity=university` / `amenity=college` / `amenity=hospital` — mapped to `campus`, which is a WOF placetype already
 *   in `WOF_VENUE_STRUCTURE_PLACETYPES`. `wof-osm-placetype-map.mdx` rates the WOF↔OSM mapping for `campus` as MODERATE
 *   confidence (no single tag; these three amenities plus `landuse=education`), so treat these rows as the weakest in
 *   the table.
 *
 * NOT here, deliberately: `indoor=*` (Simple Indoor Tagging). `wof-osm-placetype-map.mdx` establishes that concourses
 * and wings live in OSM's indoor scheme rather than its place scheme, which makes it the natural home for the
 * `concourse`/`wing` designators — but indoor features are overwhelmingly unnamed geometry primitives (`indoor=room`,
 * `indoor=corridor`), and this extractor's yield is names. Measure the named fraction before adding it.
 */
export const SUBVENUE_TAG_RULES: SubVenueTagRule[] = [
	{ designatorID: "terminal", tier: SubVenueTier.SubVenue, all: [["aeroway", "terminal"]] },
	{ designatorID: "terminal", tier: SubVenueTier.SubVenue, all: [["building", "terminal"]] },
	{ designatorID: "gate", tier: SubVenueTier.SubVenue, all: [["aeroway", "gate"]] },
	{ designatorID: "platform", tier: SubVenueTier.SubVenue, all: [["public_transport", "platform"]] },
	{ designatorID: "platform", tier: SubVenueTier.SubVenue, all: [["railway", "platform"]] },
	{ designatorID: "airport", tier: SubVenueTier.Venue, all: [["aeroway", "aerodrome"]] },
	{ designatorID: "station", tier: SubVenueTier.Venue, all: [["railway", "station"]] },
	{ designatorID: "station", tier: SubVenueTier.Venue, all: [["public_transport", "station"]] },
	{ designatorID: "campus", tier: SubVenueTier.Venue, all: [["amenity", "university"]] },
	{ designatorID: "campus", tier: SubVenueTier.Venue, all: [["amenity", "college"]] },
	{ designatorID: "campus", tier: SubVenueTier.Venue, all: [["amenity", "hospital"]] },
]

/**
 * The OSM driver layers that can carry a named transport structure: nodes and closed ways/relations. `lines` is
 * excluded — a platform mapped as an open way is an edge case whose name duplicates the node or area version.
 */
const SUBVENUE_LAYERS = ["points", "multipolygons"] as const

/**
 * Tag keys GDAL's default `osmconf.ini` promotes to real OGR fields, PER LAYER. See the module docstring for why this
 * cannot be one flat set the way `extract-poi.ts`'s can. Only the keys this extractor reads are listed; the real
 * `attributes=` lines are longer.
 */
export const PROMOTED_KEYS_BY_LAYER: Readonly<Record<string, ReadonlySet<string>>> = {
	points: new Set(["name", "ref", "place", "man_made"]),
	multipolygons: new Set(["name", "aeroway", "amenity", "building", "place", "man_made"]),
}

/**
 * OSM tag key/value shape: letters, digits, underscore, colon, dot, hyphen. {@link buildSubVenueSQL} interpolates rule
 * keys/values directly into an OGRSQL string and `rules` is a public, caller-suppliable parameter, so every token is
 * checked against this allowlist first — same guard, same reasoning as `extract-poi.ts`'s `SAFE_TAG_TOKEN`. A hostile
 * value such as `a' OR 1=1 --` would otherwise close the `'...'` literal early and inject arbitrary OGRSQL.
 */
const SAFE_TAG_TOKEN = /^[A-Za-z0-9_:.-]+$/

/**
 * Throws if any rule carries a key or value outside {@link SAFE_TAG_TOKEN}.
 */
function assertSafeTagRules(rules: readonly SubVenueTagRule[]): void {
	for (const rule of rules) {
		for (const [key, value] of rule.all) {
			for (const [kind, token] of [
				["key", key],
				["value", value],
			] as const) {
				if (!SAFE_TAG_TOKEN.test(token)) {
					throw new Error(
						`buildSubVenueSQL: rule ${kind} ${JSON.stringify(token)} (designator ${JSON.stringify(rule.designatorID)}) ` +
							`contains characters outside the OSM tag-token allowlist ${SAFE_TAG_TOKEN} — refusing to interpolate it ` +
							`into OGRSQL`
					)
				}
			}
		}
	}
}

/**
 * Distinct tag keys referenced across a rule table's `all` conjunctions, in first-seen order.
 */
export function distinctSubVenueTagKeys(rules: readonly SubVenueTagRule[]): string[] {
	const seen = new Set<string>()

	for (const rule of rules) {
		for (const [key] of rule.all) {
			seen.add(key)
		}
	}

	return [...seen]
}

/**
 * The SQL expression reading a tag's value on `layer`: a bare column when the layer promotes it, an `other_tags` hstore
 * lookup otherwise.
 */
function tagSelectExpr(layer: string, key: string): string {
	return PROMOTED_KEYS_BY_LAYER[layer]?.has(key) ? key : `hstore_get_value(other_tags,'${key}')`
}

/**
 * OGRSQL column aliases can't contain `:` — launder it the way GDAL's own `attribute_name_laundering` would.
 */
function tagAlias(key: string): string {
	return key.replaceAll(":", "_")
}

/**
 * Build the OGRSQL SELECT+WHERE for one layer.
 *
 * Selects `name` and `ref` (the identifier half of `Gate A12` lives in `ref` far more reliably than in `name`), every
 * key the rule table references, and `other_tags` WHOLESALE for the `name:<lang>` harvest. The WHERE is an OR of the
 * table's AND-groups, pushed down so GDAL scans rather than this process. The pushdown is an optimization only: a GDAL
 * dialect quirk could narrow what it matches but never widen it, and {@link matchSubVenueTagRule} re-checks the same
 * table in JS before any row is yielded, so no false positive survives even if the predicate were imprecise.
 *
 * Throws via the tag-token allowlist if `rules` carries a hostile key or value.
 */
export function buildSubVenueSQL(layer: string, rules: readonly SubVenueTagRule[] = SUBVENUE_TAG_RULES): string {
	assertSafeTagRules(rules)

	const promoted = PROMOTED_KEYS_BY_LAYER[layer] ?? new Set<string>()
	const cols = ["name"]

	// `ref` is promoted on `points` only; on `multipolygons` it arrives inside `other_tags`, where the
	// JS-side decode picks it up without a dedicated column.
	if (promoted.has("ref")) {
		cols.push("ref")
	}

	for (const key of distinctSubVenueTagKeys(rules)) {
		cols.push(`${tagSelectExpr(layer, key)} AS ${tagAlias(key)}`)
	}

	cols.push("other_tags")

	const whereGroups = rules.map(
		(rule) => "(" + rule.all.map(([key, value]) => `${tagSelectExpr(layer, key)}='${value}'`).join(" AND ") + ")"
	)

	return `SELECT ${cols.join(", ")} FROM ${layer} WHERE ${whereGroups.join(" OR ")}`
}

/**
 * PURE tag-rule matcher: the FIRST rule whose `all` conjunction is fully satisfied by `tags` wins, `null` when none do.
 * `tags` is a plain key → value dict, so this is unit-testable over synthetic dicts with no GDAL involved.
 */
export function matchSubVenueTagRule(
	tags: Readonly<Record<string, string | undefined>>,
	rules: readonly SubVenueTagRule[] = SUBVENUE_TAG_RULES
): SubVenueTagRule | null {
	for (const rule of rules) {
		if (rule.all.every(([key, value]) => tags[key] === value)) {
			return rule
		}
	}

	return null
}

/**
 * Parse GDAL's `other_tags` hstore rendering into a plain dict.
 *
 * The format is `"key"=>"value","key2"=>"value2"`, with `\"` and `\\` escaped inside either half. A regex split on `,`
 * is WRONG — comma is ordinary text inside a value, and OSM names contain them (`"name"=>"Terminal 1, Departures"`) —
 * so this is a character scanner that only leaves a quoted string on an unescaped quote.
 *
 * Returns an empty dict for `null`/empty input rather than throwing: `other_tags` is absent whenever every tag on a
 * feature was promoted, which is an ordinary outcome, not a fault.
 */
export function parseOSMHstore(text: string | null | undefined): Record<string, string> {
	const out: Record<string, string> = {}

	if (!text) return out

	let i = 0

	/**
	 * Read one `"…"` literal starting at the next quote, honoring backslash escapes. Returns `null` at end of input.
	 */
	const readQuoted = (): string | null => {
		while (i < text.length && text[i] !== '"') {
			i++
		}

		if (i >= text.length) return null

		i++

		let value = ""

		while (i < text.length) {
			const ch = text[i]!

			if (ch === "\\") {
				// A backslash escapes the next character verbatim — the only two GDAL emits are `\"` and `\\`,
				// but passing anything else through unchanged is the lossless choice.
				if (i + 1 < text.length) {
					value += text[i + 1]
				}

				i += 2

				continue
			}

			if (ch === '"') {
				i++

				return value
			}

			value += ch

			i++
		}

		// Unterminated literal — treat what we read as the value rather than dropping the whole feature.
		return value
	}

	while (i < text.length) {
		const key = readQuoted()

		if (key === null) break

		// Step over the `=>` separator; a malformed pair just resolves to the next quoted run.
		const value = readQuoted()

		if (value === null) break
		out[key] = value
	}

	return out
}

/**
 * Language codes harvested off `name:<lang>` keys. Deliberately permissive — OSM carries BCP-47-ish subtags (`zh-Hant`,
 * `pt-BR`) alongside bare ISO 639 codes, and the lexicon build downstream is the right place to decide which it trusts.
 * What this rejects is the `name:*` keys that are NOT languages: `name:left`, `name:right`, `name:prefix`,
 * `name:signed`, `name:etymology` and friends, which are documented OSM semantics with nothing linguistic about them.
 */
const NON_LANGUAGE_NAME_SUFFIXES = new Set([
	"left",
	"right",
	"prefix",
	"suffix",
	"signed",
	"source",
	"etymology",
	"pronunciation",
	"abbreviation",
	"botanical",
	"carto",
])

const LANGUAGE_SUBTAG = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

/**
 * Pull the `name:<lang>` family out of a tag dict, keyed by the raw subtag as OSM wrote it.
 */
export function harvestLocalizedNames(tags: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [key, value] of Object.entries(tags)) {
		if (!value || !key.startsWith("name:")) continue

		const subtag = key.slice("name:".length)

		if (NON_LANGUAGE_NAME_SUFFIXES.has(subtag) || !LANGUAGE_SUBTAG.test(subtag)) continue
		out[subtag] = value
	}

	return out
}

/**
 * One extracted transport structure. The shape a sub-venue lexicon build and a corpus shard both read.
 */
export interface SubVenueSourceRow {
	/**
	 * The designator the matched rule attests — `terminal`, `gate`, `platform`, `station`, `airport`, `campus`.
	 */
	designatorID: string
	tier: SubVenueTier
	/**
	 * The feature's default `name` tag, `null` when unnamed. A gate is very often unnamed and carries only `ref`.
	 */
	name: string | null
	/**
	 * The feature's `ref` tag — the identifier half of `Gate A12` / `Terminal 2F`, which OSM keeps out of `name` far more
	 * consistently than it keeps it in.
	 */
	ref: string | null
	/**
	 * `name:<lang>` → value, the localized surfaces. Empty when the feature carries none.
	 */
	localizedNames: Record<string, string>
	latitude: number
	longitude: number
	/**
	 * `key=value` of the rule branch that matched, so a row's provenance survives into the lexicon.
	 */
	matchedTag: string
	/**
	 * Always `""` — see the module docstring. The caller stamps the invocation's country.
	 */
	country: string
}

const isFinitePair = (lon: unknown, lat: unknown): boolean =>
	typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)

/**
 * Reduce a GeoJSON geometry to one representative coordinate: the point itself, or a ring-vertex average for a polygon.
 * Same helper as `extract-poi.ts`'s (not exported there); a vertex average is an acceptable venue-tier centroid, and
 * nothing downstream of this module resolves at rooftop precision.
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
 * Decode one ogr2ogr GeoJSONSeq feature into a {@link SubVenueSourceRow}, or `null` when it satisfies no rule, carries
 * no usable geometry, or has no name of ANY kind (no `name`, no `ref`, no `name:<lang>`).
 *
 * The last condition is the yield filter that matters: unnamed geometry is the majority of `railway=platform` and
 * `aeroway=gate` in OSM, and a lexicon built from names has nothing to learn from a row that has none.
 *
 * `promotedProps` are the feature's own GeoJSON properties (aliased tag columns plus `name`/`ref`); everything else
 * comes out of the parsed `other_tags` hstore. The two are merged before matching because a key's side of that split is
 * a property of the LAYER, not of the rule.
 */
export function toSubVenueSourceRow(
	feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } },
	rules: readonly SubVenueTagRule[],
	tagKeys: readonly string[]
): SubVenueSourceRow | null {
	const p = feature.properties ?? {}
	const hstore = parseOSMHstore(typeof p["other_tags"] === "string" ? p["other_tags"] : null)
	const tags: Record<string, string | undefined> = { ...hstore }

	// Aliased rule columns win over the hstore: on a layer that promotes the key, the hstore has no
	// entry for it at all, and on a layer that does not, the alias was READ from the hstore anyway.
	for (const key of tagKeys) {
		const raw = p[tagAlias(key)]

		if (raw != null && raw !== "") {
			tags[key] = String(raw)
		}
	}

	const rule = matchSubVenueTagRule(tags, rules)

	if (!rule) return null

	const pt = representativePoint(feature.geometry)

	if (!pt) return null

	const rawName = p["name"] ?? tags["name"]
	const rawRef = p["ref"] ?? tags["ref"]
	const name = rawName != null && rawName !== "" ? String(rawName) : null
	const ref = rawRef != null && rawRef !== "" ? String(rawRef) : null
	const localizedNames = harvestLocalizedNames(tags)

	if (!name && !ref && !Object.keys(localizedNames).length) return null

	const matched = rule.all.find(([key]) => tags[key] !== undefined) ?? rule.all[0]!

	return {
		designatorID: rule.designatorID,
		tier: rule.tier,
		name,
		ref,
		localizedNames,
		longitude: pt[0],
		latitude: pt[1],
		matchedTag: `${matched[0]}=${matched[1]}`,
		country: "",
	}
}

/**
 * Run ogr2ogr against one layer, yielding matched {@link SubVenueSourceRow}s from its GeoJSONSeq stdout. Mirrors
 * `extract-poi.ts`'s `runPOILayer` process-spawn / stderr-capture / exit-code idiom exactly.
 */
async function* runSubVenueLayer(
	pbfPath: string,
	layer: string,
	rules: readonly SubVenueTagRule[]
): AsyncGenerator<SubVenueSourceRow> {
	const tagKeys = distinctSubVenueTagKeys(rules)
	const sql = buildSubVenueSQL(layer, rules)
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

		const feature = tryParsingJSON<{
			properties?: Record<string, unknown>
			geometry?: { type?: string; coordinates?: unknown }
		}>(line)

		if (!feature) continue

		const row = toSubVenueSourceRow(feature, rules, tagKeys)

		if (row) {
			yield row
		}
	}

	const code = await exit

	if (code !== 0) throw new Error(`ogr2ogr (${layer}) exited ${code}: ${stderr.slice(-800)}`)
}

/**
 * Stream every named transport structure matching `rules` (default {@link SUBVENUE_TAG_RULES}) out of a `.osm.pbf`
 * extract's `points` + `multipolygons` layers.
 *
 * A feature mapped as both a node and an area (common for large terminals) yields TWICE, once per layer, with different
 * coordinates. De-duplication is the consumer's call — the lexicon build counts distinct surfaces and does not care,
 * while a corpus shard would.
 */
export async function* extractOSMSubVenues(
	pbfPath: string,
	rules: SubVenueTagRule[] = SUBVENUE_TAG_RULES
): AsyncIterable<SubVenueSourceRow> {
	for (const layer of SUBVENUE_LAYERS) {
		yield* runSubVenueLayer(pbfPath, layer, rules)
	}
}
