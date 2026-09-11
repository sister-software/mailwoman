/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Static sub-venue tag rules and OGR SQL construction.
 */

import {
	assertSafeTagRules,
	distinctTagKeys,
	type PromotedKeysByLayer,
	tagAlias,
	tagSelectExpr,
} from "#sdk/tag-columns"

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
 * Order is required in exactly one place: a station platform commonly carries BOTH `public_transport=platform` and
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
export const SUBVENUE_LAYERS = ["points", "multipolygons"] as const

/**
 * Tag keys GDAL's default `osmconf.ini` promotes to real OGR fields, PER LAYER. See the module docstring for why this
 * cannot be one flat set the way `extract-poi.ts`'s can. Only the keys this extractor reads are listed; the real
 * `attributes=` lines are longer.
 */
export const PROMOTED_KEYS_BY_LAYER: PromotedKeysByLayer = {
	points: new Set(["name", "ref", "place", "man_made"]),
	multipolygons: new Set(["name", "aeroway", "amenity", "building", "place", "man_made"]),
}

/**
 * Distinct tag keys referenced across a rule table's `all` conjunctions, in first-seen order — the shared
 * {@link distinctTagKeys}, re-exported under this module's established name.
 */
export function distinctSubVenueTagKeys(rules: readonly SubVenueTagRule[]): string[] {
	return distinctTagKeys(rules)
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
	assertSafeTagRules(rules, "buildSubVenueSQL")

	const promoted = PROMOTED_KEYS_BY_LAYER[layer] ?? new Set<string>()
	const cols = ["name"]

	// `ref` is promoted on `points` only; on `multipolygons` it arrives inside `other_tags`, where the
	// JS-side decode picks it up without a dedicated column.
	if (promoted.has("ref")) {
		cols.push("ref")
	}

	for (const key of distinctSubVenueTagKeys(rules)) {
		cols.push(`${tagSelectExpr(PROMOTED_KEYS_BY_LAYER, layer, key)} AS ${tagAlias(key)}`)
	}

	cols.push("other_tags")

	const whereGroups = rules.map(
		(rule) =>
			"(" +
			rule.all.map(([key, value]) => `${tagSelectExpr(PROMOTED_KEYS_BY_LAYER, layer, key)}='${value}'`).join(" AND ") +
			")"
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
