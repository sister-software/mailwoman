/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Venue-INTERIOR structural designators, sourced from the Who's On First placetype vocabulary.
 *
 *   WHY THIS IS NOT A POSTAL TABLE, AND WHY THAT IS THE POINT. The span proposer's other designator
 *   sources are mail-delivery standards — USPS Publication 28 C2, Australia Post AMAS, NZ Post
 *   ADV358 — and they are right to omit these words. Mail is not delivered to a concourse. But the
 *   DECODER's job is to pull an address apart with the richest vocabulary available; only the
 *   FORMATTER owes allegiance to a postal system's rendering rules. Those are different jobs, and
 *   the split is structural here: this module feeds `neural/span-proposer-lexicon.ts` and nothing in
 *   `formatter/` reads it, so a decoder that understands "Concourse B" still renders addresses
 *   through Pub 28.
 *
 *   PROVENANCE. Every entry below is a real vocabulary term, not an invention:
 *
 *   - `arcade`, `building`, `campus`, `concourse`, `enclosure`, `installation`, `wing` are WOF
 *       placetypes — the same vocabulary `placetype-evidence.mdx` already projects onto
 *       `venue`/`unit` sub-structure. They are typed as {@link WhosOnFirstPlacetype} below, so if
 *       WOF's vocabulary ever changes, this list stops compiling rather than drifting.
 *   - `terminal` and `gate` come from OpenStreetMap's `aeroway` key (`aeroway=terminal`,
 *       `aeroway=gate`), documented tags the repo already ingests through `osm/sdk`. WOF has no
 *       equivalent placetype, and they are the two most common sub-venue designators in real
 *       airport addresses — the class that motivated this module.
 *
 *   WHY THE LIST LIVES IN `neural/` WHILE THE VOCABULARY IT IS PINNED TO LIVES IN `core/`. The pin is a
 *   TYPE (`satisfies readonly WhosOnFirstPlacetype[]`), and a type-only import is erased at build — so the
 *   compiler still refuses any entry WOF does not define, at zero bundle cost. A VALUE import of the
 *   vocabulary would not be free: `@mailwoman/core/resources/whosonfirst` re-exports `PlacetypeDataSource`,
 *   which imports `node:sqlite`, and pulling that barrel into the span proposer broke the docs browser
 *   bundle (2026-08-02). The span proposer is this list's only consumer, so it owns it.
 *
 *   WHAT MOTIVATED IT (2026-08-02, campaign R5 follow-on). `Building 43, Googleplex, 1600
 *   Amphitheatre Parkway` already parsed correctly, because BUILDING happens to be in Pub 28. In
 *   the same breath `Terminal 5, Heathrow Airport, Hounslow, TW6 2GA` collapsed to
 *   `locality="Terminal"`, `house_number=5`, with the airport dropped entirely — TERMINAL is not a
 *   postal designator, so the proposer had never heard of it. The asymmetry was the source's, not
 *   the parser's.
 */

import type { WhosOnFirstPlacetype } from "@mailwoman/core/resources/whosonfirst"

/**
 * WOF placetypes that name a structure INSIDE a venue rather than a place on the map.
 *
 * Deliberately excludes `venue` itself (the container, not an interior division) and `address`/`intersection` (grammar
 * anchors, handled by the parser proper). Typed against {@link WhosOnFirstPlacetype} so the compiler enforces that each
 * entry is a genuine WOF term.
 */
export const WOF_VENUE_STRUCTURE_PLACETYPES = [
	"arcade",
	"building",
	"campus",
	"concourse",
	"enclosure",
	"installation",
	"wing",
] as const satisfies readonly WhosOnFirstPlacetype[]

/**
 * Sub-venue designators from OpenStreetMap's `aeroway` key, which WOF's placetype vocabulary does not cover.
 *
 * Kept as its own list rather than merged above precisely so the provenance stays legible: these are OSM tag values,
 * not WOF placetypes, and a reader tracing where "terminal" came from should land on the right standard.
 */
export const OSM_AEROWAY_STRUCTURE_DESIGNATORS = ["terminal", "gate"] as const

/**
 * Every venue-interior designator the span proposer recognizes, lowercased.
 *
 * NOTE the deliberate omission of abbreviations. Pub 28 ships them (`STE`, `BLDG`) because mailers write them; these
 * words are written in full on signage and in venue addresses, and a two-or-three letter abbreviation is exactly the
 * false-positive shape the AU/NZ tables already taught this lexicon to avoid ("Ms Smith" for `MS`). Add one only with a
 * measured need.
 */
export const VENUE_STRUCTURE_DESIGNATORS: readonly string[] = [
	...WOF_VENUE_STRUCTURE_PLACETYPES,
	...OSM_AEROWAY_STRUCTURE_DESIGNATORS,
]

/**
 * Positional modifiers that precede a venue-interior designator: "West Wing", "Upper Concourse", "Main Building".
 *
 * A bounded structural category — compass points, vertical position, centrality — not a dictionary of names. The
 * compass terms match the directional vocabulary `@mailwoman/codex` already carries for street parsing
 * (`CA_DIRECTIONALS`); the rest are the positional words that serve the same grammatical role inside a venue.
 *
 * Deliberately EXCLUDES abbreviations (`N`, `W`, `NE`). Postal directionals abbreviate because mailers write them that
 * way on a street line; a sub-venue name written on signage does not, and a bare capital letter beside a designator is
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
 * Venue-interior designators that may be preceded by a {@link VENUE_STRUCTURE_MODIFIERS} term.
 *
 * A SUBSET of {@link VENUE_STRUCTURE_DESIGNATORS}, and the difference is the whole point. `gate` and `building` form
 * ordinary street names in exactly this shape — "East Gate" and "West Gate" are real GB streets, "Building Society
 * Place" is a real street — so admitting them here would turn a correct street parse into a sub-venue one. The
 * designators listed below do not name streets in the modifier+designator shape.
 *
 * Adding an entry means claiming no street is named "<modifier> <entry>". Check before you do.
 */
export const MODIFIER_ELIGIBLE_STRUCTURE_DESIGNATORS: readonly string[] = [
	"wing",
	"concourse",
	"terminal",
	"arcade",
	"campus",
]
