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
 *   WHAT MOTIVATED IT (2026-08-02, campaign R5 follow-on). `Building 43, Googleplex, 1600
 *   Amphitheatre Parkway` already parsed correctly, because BUILDING happens to be in Pub 28. In
 *   the same breath `Terminal 5, Heathrow Airport, Hounslow, TW6 2GA` collapsed to
 *   `locality="Terminal"`, `house_number=5`, with the airport dropped entirely — TERMINAL is not a
 *   postal designator, so the proposer had never heard of it. The asymmetry was the source's, not
 *   the parser's.
 */

import type { WhosOnFirstPlacetype } from "./definition.ts"

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
