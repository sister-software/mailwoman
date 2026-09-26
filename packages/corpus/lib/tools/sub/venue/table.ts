/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The sub-venue lexicon's record schema and the shipped vocabulary it is seeded from.
 *
 * The seeds duplicate `neural/venue-structure.ts` knowingly: `@mailwoman/corpus` does not depend on
 * `@mailwoman/neural`, so the shipped vocabulary is re-declared here, and `sub-venue-lexicon.test.ts`
 * pins the seed literally so a change in either place fails a test.
 */

import type { SubVenuePromotion } from "#tools/sub/venue/promotions"

/**
 * This table's own data version; bump when the source vintages or the build semantics change.
 */
export const SUBVENUE_LEXICON_VERSION = "0.2.0"

/**
 * Which side of the containment relation a designator names; mirrors `@mailwoman/osm/sdk`'s
 * `SubVenueTier`, re-declared for the same dependency-direction reason as the seed.
 */
export const LexiconTier = {
	SubVenue: "subvenue",
	Venue: "venue",
} as const

export type LexiconTier = (typeof LexiconTier)[keyof typeof LexiconTier]

/**
 * One designator record — a venue-interior (or containing-venue) structural noun.
 */
export interface SubVenueDesignator {
	/**
	 * Canonical id, lowercase English; matches `neural/venue-structure.ts`'s
	 * `VENUE_STRUCTURE_DESIGNATORS` wherever the two overlap.
	 */
	id: string
	tier: LexiconTier
	/**
	 * Whether this designator may be preceded by a {@link SubVenueModifier} — the `North Terminal` shape;
	 * `gate` and `building` are excluded because `<modifier> <id>` is also an ordinary street
	 * name ("East Gate"), so admitting them turns a correct street parse into a sub-venue one.
	 */
	modifierEligible: boolean
	/**
	 * Whether the shipped span proposer recognizes this designator; `false` means no consumer reads it yet.
	 */
	shipped: boolean
	/**
	 * Where the term comes from, one entry per attesting source (`wof:placetype`, `osm:aeroway=terminal`,
	 * `wikidata:Q849706`, `overture:airport_terminal`), sorted so a regenerate is stable.
	 */
	provenance: string[]
}

/**
 * One positional modifier — the `North`/`Upper`/`Main` half of `North Terminal`.
 */
export interface SubVenueModifier {
	id: string
	shipped: boolean
	provenance: string[]
}

/**
 * One surface form: a phrase, the record it names, and where it was attested.
 */
export interface SubVenueSurface {
	/**
	 * The phrase, lowercased for Latin script and left as written otherwise; the Turkish `İ`
	 * (U+0130) is `\p{Script=Latin}` and folds to `i` plus a combining dot above, so it round-trips
	 * through a form its own locale would not write (no shipped code depends on that today).
	 */
	phrase: string
	recordID: string
	recordKind: "designator" | "modifier"
	/**
	 * BCP-47-ish language subtag as the source wrote it (`en`, `ja`, `zh-Hant`, `pt-BR`),
	 * or `und` when the source gave an untagged default name.
	 */
	lang: string
	/**
	 * ISO 3166-1 alpha-2 of the data the phrase was attested in, `""` for vocabulary sources
	 * that attest a term's existence rather than its use; this is the axis promotion is
	 * decided on (`hall` is attested 3,274 times in `GB`), never a global census.
	 */
	region: string
	/**
	 * `wikidata:label`, `wikidata:alt`, `osm:name`, `osm:name:<lang>`, `overture:name`,
	 * `derived:head-noun`, or `seed`.
	 */
	source: string
	/**
	 * Whether a human has approved this surface for parsing use in its region; everything
	 * machine-derived starts `false` and only a matching {@link SubVenuePromotion} flips it,
	 * so a consumer that gates a parse must filter on this.
	 */
	curated: boolean
	/**
	 * How many source features attested this exact phrase when the source counts (OSM, Overture);
	 * `0` for vocabulary sources, which attest a term's existence rather than its frequency.
	 */
	observations: number
	/**
	 * The rule-assigned designator of the features that carried this phrase, with a count
	 * each (`platform:3205 campus:49` for GB's `hall`); empty for vocabulary sources.
	 *
	 * Without it an `observations` count is a magnitude with no sign
	 * (`hall` on a `platform` row is a British bus stop named after a village hall;
	 * on a `terminal` row it is a real German departure hall).
	 */
	context: Record<string, number>
}

/**
 * The measured shape of a designator's identifier half — what follows `Gate`/`Terminal` in real data.
 *
 * Derived from OSM `ref` values rather than names: every one of Berlin's 26 `aeroway=gate` features
 * is unnamed and carries only a `ref`, so `Gate A12` is a rendering (`<designator> <ref>`)
 * rather than a string anyone wrote down, and generating that form needs the identifier distribution.
 */
export interface IdentifierShape {
	designatorID: string
	/**
	 * ISO 3166-1 alpha-2 of the extract this distribution was measured in; per-region because the
	 * shapes differ (GB gates are 70% bare digits, Japanese platform refs a different range),
	 * so a recipe for a French address should sample France's distribution.
	 */
	region: string
	/**
	 * A coarse class: `digit` (`5`), `letter` (`B`), `letter-digit` (`A12`),
	 * `digit-letter` (`2F`), `range` (`16-18`, `0/1`), or `other`.
	 */
	shape: string
	observations: number
	/**
	 * Up to eight real values, sorted.
	 */
	examples: string[]
}

/**
 * One input source's provenance, copied off its fetch manifest.
 */
export interface SubVenueLexiconSource {
	id: string
	origin: string
	license: string
	retrieved: string
	rows: number
}

/**
 * The committed table.
 */
export interface SubVenueLexiconTable {
	version: string
	sources: SubVenueLexiconSource[]
	designators: SubVenueDesignator[]
	modifiers: SubVenueModifier[]
	surfaces: SubVenueSurface[]
	identifierShapes: IdentifierShape[]
	/**
	 * Every curation decision taken against this table, promotion and rejection,
	 * each with the census that backs it; a rejection is as required as a promotion
	 * because it stops the next reader re-proposing `hall` for en-GB.
	 */
	promotions: SubVenuePromotion[]
}

/**
 * The vocabulary that already ships in `neural/venue-structure.ts`, re-declared
 * below for the module docstring's dependency-direction reason.
 *
 * `tier` is added here: the seven WOF placetypes plus `terminal`/`gate` are all venue-interior,
 * while `campus` and `building` name a whole venue as often as a part of one
 * but are marked `subvenue` because that is the role the span proposer uses them in.
 */
export const SHIPPED_DESIGNATOR_SEED: ReadonlyArray<{
	id: string
	modifierEligible: boolean
	provenance: string[]
}> = [
	{ id: "arcade", modifierEligible: true, provenance: ["wof:placetype"] },
	{ id: "building", modifierEligible: false, provenance: ["wof:placetype"] },
	{ id: "campus", modifierEligible: true, provenance: ["wof:placetype"] },
	{ id: "concourse", modifierEligible: true, provenance: ["wof:placetype"] },
	{ id: "enclosure", modifierEligible: false, provenance: ["wof:placetype"] },
	{ id: "gate", modifierEligible: false, provenance: ["osm:aeroway=gate"] },
	{ id: "installation", modifierEligible: false, provenance: ["wof:placetype"] },
	{ id: "terminal", modifierEligible: true, provenance: ["osm:aeroway=terminal"] },
	{ id: "wing", modifierEligible: true, provenance: ["wof:placetype"] },
]

/**
 * The shipped positional modifiers, re-declared from `neural/venue-structure.ts`'s `VENUE_STRUCTURE_MODIFIERS`.
 */
export const SHIPPED_MODIFIER_SEED: readonly string[] = [
	"central",
	"east",
	"front",
	"inner",
	"lower",
	"main",
	"north",
	"outer",
	"rear",
	"south",
	"upper",
	"west",
]

/**
 * Designators the lexicon adds beyond what ships, each with the source that attests it.
 *
 * None is `modifierEligible`: that claim needs a confound board per term and per locale,
 * and a promotion marks a surface usable without widening the modifier grammar.
 */
export const PROPOSED_DESIGNATORS: ReadonlyArray<{
	id: string
	tier: LexiconTier
	provenance: string[]
}> = [
	{ id: "airport", tier: LexiconTier.Venue, provenance: ["osm:aeroway=aerodrome"] },
	{ id: "hall", tier: LexiconTier.SubVenue, provenance: ["wikidata:Q240854"] },
	{ id: "pier", tier: LexiconTier.SubVenue, provenance: ["overture:pier"] },
	{ id: "platform", tier: LexiconTier.SubVenue, provenance: ["osm:public_transport=platform", "osm:railway=platform"] },
	{ id: "satellite", tier: LexiconTier.SubVenue, provenance: ["wikidata:Q15990706"] },
	{ id: "station", tier: LexiconTier.Venue, provenance: ["osm:railway=station"] },
]

/**
 * `designatorID` → Wikidata QID, mirroring `fetch/wikidata-subvenue.ts`'s `SUBVENUE_CONCEPTS`;
 * the builder stays a pure function over parsed input, and the test pins the two against each other.
 */
export const CONCEPT_QIDS: Readonly<Record<string, string>> = {
	terminal: "Q849706",
	gate: "Q247739",
	concourse: "Q862212",
	campus: "Q209465",
	building: "Q41176",
	arcade: "Q186637",
	hall: "Q240854",
	satellite: "Q15990706",
}
