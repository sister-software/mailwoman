/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Venue-interior structural designators, sourced from the Who's On First placetype vocabulary.
 *
 *   These words are not a postal table and that is the point: the span proposer's other designator
 *   sources are mail-delivery standards (USPS Publication 28 C2, Australia Post amas, NZ Post
 *   ADV358) and correctly omit them, because mail is not delivered to a concourse, while the
 *   decoder's job is to pull an address apart with the richest vocabulary available. This module
 *   feeds `neural/span-proposer-lexicon.ts` and no module in `formatter/` reads it.
 *
 *   Provenance: `arcade`, `building`, `campus`, `concourse`, `enclosure`, `installation` and `wing`
 *   are WOF placetypes; `terminal` and `gate` are OpenStreetMap `aeroway` tag values, which WOF's
 *   vocabulary does not cover.
 *
 *   The pin is a type-only import (`satisfies readonly WhosOnFirstPlacetype[]`) erased at build, so
 *   the compiler refuses an entry WOF does not define at zero bundle cost; a value import of the
 *   vocabulary would pull `node:sqlite` through `PlacetypeDataSource` into the span proposer.
 */

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"

/**
 * WOF placetypes that name a structure inside a venue rather than a place on the map,
 * deliberately excluding `venue` itself and the `address`/`intersection` grammar anchors;
 * typed against {@link WhosOnFirstPlacetype} so the compiler enforces each entry is a genuine WOF term.
 */
const WOF_VENUE_STRUCTURE_PLACETYPES = [
	"arcade",
	"building",
	"campus",
	"concourse",
	"enclosure",
	"installation",
	"wing",
] as const satisfies readonly WhosOnFirstPlacetype[]

/**
 * Sub-venue designators from OpenStreetMap's `aeroway` key, kept as its own list
 * so the provenance stays legible: these are OSM tag values rather than WOF placetypes.
 */
const OSM_AEROWAY_STRUCTURE_DESIGNATORS = ["terminal", "gate"] as const

/**
 * Every venue-interior designator the span proposer recognizes, lowercased and deliberately
 * without abbreviations: these words are written in full on signage, and a two-or-three letter
 * abbreviation is the false-positive shape ("Ms Smith" for `MS`) the lexicon already avoids.
 * Add one only with a measured need.
 */
export const VENUE_STRUCTURE_DESIGNATORS: readonly string[] = [
	...WOF_VENUE_STRUCTURE_PLACETYPES,
	...OSM_AEROWAY_STRUCTURE_DESIGNATORS,
]

/**
 * Positional modifiers that precede a venue-interior designator: a bounded structural
 * category (compass points, vertical position, centrality) rather than a dictionary of names,
 * with the compass terms matching `@mailwoman/codex`'s `CA_DIRECTIONALS`.
 *
 * Abbreviations are deliberately excluded: a bare capital letter beside a designator is
 * the identifier shape the designator+identifier rule already owns ("Wing B").
 */
export const VENUE_STRUCTURE_MODIFIERS: readonly string[] = [
	"north",
	"south",
	"east",
	"west",
	"upper",
	"lower",
	"main",
	"central",
	"inner",
	"outer",
	"front",
	"rear",
]

/**
 * Venue-interior designators that may be preceded by a {@link VENUE_STRUCTURE_MODIFIERS} term:
 * a subset of {@link VENUE_STRUCTURE_DESIGNATORS} that excludes `gate` and `building`, which form
 * ordinary street names in the modifier+designator shape ("East Gate", "Building Society Place").
 *
 * Adding an entry means claiming no street is named "<modifier> <entry>"; check before you do.
 */
export const MODIFIER_ELIGIBLE_STRUCTURE_DESIGNATORS: readonly string[] = [
	"wing",
	"concourse",
	"terminal",
	"arcade",
	"campus",
]
