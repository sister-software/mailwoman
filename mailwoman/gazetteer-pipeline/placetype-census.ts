/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Hierarchy campaign R4c — build the PCN1 placetype census from the shipped WOF admin DB. Two
 *   pieces live here: {@link PLACETYPE_PROJECTION}, the executable form of the projection table in
 *   plan/reference/placetype-evidence.mdx ("no placetype gets its own tag; every placetype gets a
 *   projection"), and {@link buildPlacetypeCensus}, which counts each parent's children THROUGH that
 *   projection.
 *
 *   The census counts what the source can actually answer. `admin-global-priority.db` carries nine
 *   placetypes (locality, localadmin, neighbourhood, borough, county, macrocounty, region,
 *   macroregion, country) because `ADMIN_PLACETYPES` in `admin/ingest-wof.ts` allowlists exactly
 *   those; the projection table maps all 34 in the WOF vocabulary. The other 25 are absent from the
 *   artifact by BUILD RECIPE, not by WOF's contents — which is COVERAGE, not fact (the
 *   meaning-of-zero rule), and why the artifact ships positive counts only and the reader treats a
 *   missing node as neutral. `mailwoman gazetteer granularity` measures the difference.
 *
 *   Inclusion rule: a parent enters the census only if it has at least one child projecting onto a
 *   tag OTHER than `locality`. A node recording "this locality has 300 locality children" is true
 *   and useless — every locality has those — and including them would inflate the artifact by two
 *   orders of magnitude for zero discriminative mass. The tag whose conditional prior this arc is
 *   about (`dependent_locality`) is exactly the one the rule keeps.
 */

import { DatabaseSync } from "node:sqlite"

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"
import type { ComponentTag } from "@mailwoman/core/types"
import type { PlacetypeCensusNode } from "@mailwoman/neural/placetype-census"

/**
 * The complete Who's on First placetype vocabulary (35 as of 2026-08-02). {@link PLACETYPE_PROJECTION} must carry a key
 * for every entry — a test asserts it — so a placetype can never reach {@link buildPlacetypeCensus} unmapped and turn a
 * build into a throw at the worst moment. Sorted to keep the diff readable when WOF grows the vocabulary.
 *
 * Pinned to `WhosOnFirstPlacetype` (`@mailwoman/core/resources/whosonfirst`) with `satisfies`, the same discipline
 * `WOF_VENUE_STRUCTURE_PLACETYPES` uses: this list stops COMPILING if it names something outside the vocabulary. The
 * type is the authority on membership; this array exists because a type union cannot be enumerated at runtime, which is
 * what the completeness test needs. A hand-maintained copy drifted once already — it was missing `custom`.
 */
export const WOF_PLACETYPES = [
	"address",
	"arcade",
	"borough",
	"building",
	"campus",
	"concourse",
	"continent",
	"country",
	"county",
	"custom",
	"dependency",
	"disputed",
	"empire",
	"enclosure",
	"installation",
	"intersection",
	"localadmin",
	"locality",
	"macrocounty",
	"macrohood",
	"macroregion",
	"marinearea",
	"marketarea",
	"metroarea",
	"microhood",
	"nation",
	"neighbourhood",
	"ocean",
	"planet",
	"postalcode",
	"postalregion",
	"region",
	"timezone",
	"venue",
	"wing",
] as const satisfies readonly WhosOnFirstPlacetype[]

/**
 * WOF placetype → `ComponentTag` projection, the executable copy of plan/reference/placetype-evidence.mdx's table. A
 * `null` value means "in the vocabulary, deliberately NOT projected" (context-only placetypes: metroarea, timezone, and
 * the out-of-grammar continent/ocean rows) — distinct from a placetype missing from this map entirely, which is an
 * unmapped placetype the builder will refuse to count silently.
 *
 * `county`/`macrocounty` project onto `subregion` here, the US reading. Ireland writes county as an address line ("Co.
 * Kerry"), where the same rows project onto `region`; that per-locale re-projection belongs to the IE census instance
 * when it is built, not to this table, because a single global map cannot be right for both.
 */
export const PLACETYPE_PROJECTION: Readonly<Record<string, ComponentTag | null>> = {
	// Locality backbone — the census denominator for everything below it.
	locality: "locality",
	localadmin: "locality",
	// The dependent-locality family: the pair/census arc's subject.
	borough: "dependent_locality",
	neighbourhood: "dependent_locality",
	macrohood: "dependent_locality",
	microhood: "dependent_locality",
	// Administrative levels above the locality.
	county: "subregion",
	macrocounty: "subregion",
	region: "region",
	macroregion: "region",
	country: "country",
	nation: "country",
	dependency: "country",
	disputed: "country",
	postalcode: "postcode",
	venue: "venue",
	// Venue sub-structure. A WOF `building`/`campus` place carries a venue NAME ("Empire State Building", "MIT
	// Campus"); the interior subdivisions carry a unit designator ("Concourse B", "Terminal 4", "West Wing"). The
	// admin build stocks none of these today — that is the ingest allowlist (`ADMIN_PLACETYPES`), not the source, and
	// measuring the difference is what `mailwoman gazetteer granularity` exists for.
	building: "venue",
	campus: "venue",
	arcade: "unit",
	concourse: "unit",
	enclosure: "unit",
	installation: "unit",
	wing: "unit",
	// Context-only and out-of-grammar: mapped explicitly to null so an unmapped placetype stays distinguishable from a
	// deliberately-uncounted one.
	metroarea: null,
	marketarea: null,
	postalregion: null,
	timezone: null,
	continent: null,
	ocean: null,
	marinearea: null,
	planet: null,
	empire: null,
	// `custom` is WOF's escape hatch for a locally-defined placetype. It names no fixed feature class, so no projection
	// can be right for it — deliberately uncounted rather than guessed at.
	custom: null,
	// Multi-span and record placetypes: in the vocabulary, structurally unprojectable onto ONE tag. An intersection is
	// a two-span construct (`intersection_a` + `intersection_b`); a WOF `address` is a whole address record consumed by
	// the kind-classifier and the resolver's address-point tiers, not a span role.
	intersection: null,
	address: null,
}

/**
 * The projection every census parent is keyed by — a census node describes the children of a PLACE, and the placetypes
 * that host address-bearing children are the locality-class ones.
 */
const PARENT_PLACETYPES = ["locality", "localadmin"] as const

export interface PlacetypeCensusBuildResult {
	/**
	 * Census nodes, keyed by RAW parent surface — the caller applies the fold (`normalizeFSTToken`), keeping one
	 * normalization owner exactly as the pair-index path does.
	 */
	nodes: PlacetypeCensusNode[]
	/**
	 * Global child counts per projected tag across the whole country, BEFORE the inclusion rule drops locality-only
	 * parents — the denominator behind `PlacetypeCensusHeader.baseRates`.
	 */
	countryTotals: Partial<Record<ComponentTag, number>>
	/**
	 * Parent→child links counted (the census's row mass, not its node count).
	 */
	links: number
	/**
	 * Placetypes seen in the source but absent from {@link PLACETYPE_PROJECTION} — a build that reports any of these is
	 * reading a source the projection table has not been extended for.
	 */
	unmappedPlacetypes: string[]
}

/**
 * Count each parent's children through the projection table, for one country.
 *
 * Read-only against the admin DB. The child and parent must share a country — a cross-border ancestor link (WOF carries
 * some) would attribute a child's evidence to the wrong locale's artifact.
 */
export function buildPlacetypeCensus(adminDBPath: string, country: string): PlacetypeCensusBuildResult {
	const db = new DatabaseSync(adminDBPath, { readOnly: true })

	try {
		const parentList = PARENT_PLACETYPES.map((placetype) => `'${placetype}'`).join(", ")

		const rows = db
			.prepare(
				`SELECT p.name AS parent, s.placetype AS childPlacetype, COUNT(*) AS n
				 FROM spr s
				 JOIN ancestors a ON a.id = s.id
				 JOIN spr p ON p.id = a.ancestor_id
				 WHERE p.placetype IN (${parentList})
				   AND s.country = ?
				   AND p.country = s.country
				   AND s.id != p.id
				 GROUP BY p.name, s.placetype`
			)
			.all(country) as Array<{ parent: string; childPlacetype: string; n: number }>

		const byParent = new Map<string, Partial<Record<ComponentTag, number>>>()
		const countryTotals: Partial<Record<ComponentTag, number>> = {}
		const unmapped = new Set<string>()
		let links = 0

		for (const { parent, childPlacetype, n } of rows) {
			if (!parent) continue

			if (!(childPlacetype in PLACETYPE_PROJECTION)) {
				unmapped.add(childPlacetype)

				continue
			}

			const tag = PLACETYPE_PROJECTION[childPlacetype]

			if (!tag) continue

			const counts = byParent.get(parent) ?? {}

			counts[tag] = (counts[tag] ?? 0) + n
			byParent.set(parent, counts)

			countryTotals[tag] = (countryTotals[tag] ?? 0) + n
			links += n
		}

		const nodes: PlacetypeCensusNode[] = []

		for (const [parent, counts] of byParent) {
			// The inclusion rule: locality-only parents carry no discriminative mass (see the module header).
			const discriminative = Object.entries(counts).some(([tag, n]) => tag !== "locality" && (n ?? 0) > 0)

			if (!discriminative) continue

			const total = Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0)

			nodes.push({ parent, counts, total })
		}

		return { nodes, countryTotals, links, unmappedPlacetypes: [...unmapped].toSorted() }
	} finally {
		db.close()
	}
}

/**
 * Turn country-wide per-tag child counts into the shares `PlacetypeCensusHeader.baseRates` carries.
 */
export function toBaseRates(
	countryTotals: Partial<Record<ComponentTag, number>>
): Partial<Record<ComponentTag, number>> {
	const total = Object.values(countryTotals).reduce<number>((sum, n) => sum + (n ?? 0), 0)

	if (!total) return {}

	const baseRates: Partial<Record<ComponentTag, number>> = {}

	for (const [tag, n] of Object.entries(countryTotals) as Array<[ComponentTag, number]>) {
		baseRates[tag] = n / total
	}

	return baseRates
}
