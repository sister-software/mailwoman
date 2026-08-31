/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file The sub-venue lexicon's record schema and the shipped vocabulary it is seeded from — the
 *   emitted artifact's shape plus the designator, modifier and Wikidata-concept tables every build
 *   starts out holding.
 *
 *   The shape follows `@mailwoman/poi-taxonomy`'s `taxonomy.json` idiom exactly — typed records plus a
 *   FLAT phrase array keyed back to a record id, which is what makes a longest-match phrase index cheap
 *   to build over it. {@link SubVenueSurface} is this table's `SynonymEntry`.
 *
 *   The seeds DUPLICATE `neural/venue-structure.ts` knowingly: `@mailwoman/corpus` does not depend on
 *   `@mailwoman/neural` (the dependency runs the other way for the training path, and pulling
 *   onnxruntime into a corpus build to read three string arrays would be absurd), so the shipped
 *   vocabulary is re-declared here. That is a drift surface and it is stated rather than hidden —
 *   `sub-venue-lexicon.test.ts` pins the seed's contents literally, so a change in either place fails a
 *   test rather than passing silently.
 */

import type { SubVenuePromotion } from "#tools/sub-venue-promotions"

/**
 * This table's own data version. Bump when the source vintages or the build semantics change.
 *
 * `0.2.0` — wave 2: per-region attestation, the phrase-attribution fix (finding 3 above), derived head nouns, the
 * Overture source, and the `promotions[]` receipts section.
 */
export const SUBVENUE_LEXICON_VERSION = "0.2.0"

/**
 * Which side of the containment relation a designator names. Mirrors `@mailwoman/osm/sdk`'s `SubVenueTier`; re-declared
 * for the same dependency-direction reason as the seed.
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
	 * Canonical id, lowercase English. Matches `neural/venue-structure.ts`'s `VENUE_STRUCTURE_DESIGNATORS` wherever the
	 * two overlap.
	 */
	id: string
	tier: LexiconTier
	/**
	 * Whether this designator may be preceded by a {@link SubVenueModifier} — the `North Terminal` shape.
	 *
	 * A SUBSET, and the exclusions are required: `gate` and `building` form ordinary STREET names in exactly this shape
	 * ("East Gate" is a real GB street, "Building Society Place" is a real street), so admitting them turns a correct
	 * street parse into a sub-venue one. Setting this true means claiming no street is named `<modifier> <id>`. Check
	 * before you do.
	 */
	modifierEligible: boolean
	/**
	 * Whether the shipped span proposer already recognizes this designator. `false` means the lexicon proposes it and
	 * nothing consumes it yet.
	 */
	shipped: boolean
	/**
	 * Where the term comes from, one entry per attesting source: `wof:placetype`, `osm:aeroway=terminal`,
	 * `wikidata:Q849706`, `overture:airport_terminal`. Sorted, so a regenerate is stable.
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
 *
 * This is the table's `SynonymEntry` — the flat array a phrase index is built over.
 */
export interface SubVenueSurface {
	/**
	 * The phrase, lowercased for Latin-script languages and left as written otherwise — case-folding is meaningless for
	 * Han and Kana, which the script guard excludes.
	 *
	 * It does NOT exclude Turkish: `İ` (U+0130) is `\p{Script=Latin}`, so the guard admits it and `toLowerCase` folds it
	 * to `i` plus a combining dot above. A Turkish surface therefore round-trips through a form its own locale would not
	 * write. Nothing shipped depends on that today; a Turkish designator would.
	 */
	phrase: string
	/**
	 * The {@link SubVenueDesignator.id} or {@link SubVenueModifier.id} this phrase is a surface of.
	 */
	recordID: string
	/**
	 * Which record table `recordID` points into.
	 */
	recordKind: "designator" | "modifier"
	/**
	 * BCP-47-ish language subtag as the source wrote it (`en`, `ja`, `zh-Hant`, `pt-BR`), or `und` when the source gave
	 * an untagged default name.
	 */
	lang: string
	/**
	 * ISO 3166-1 alpha-2 of the DATA the phrase was attested in, `""` for vocabulary sources that attest a term's
	 * existence rather than its use anywhere. This is the axis promotion is decided on: `hall` is attested 3,274 times in
	 * `GB` and every promotion of it lives or dies on a per-region census, never a global one.
	 */
	region: string
	/**
	 * `wikidata:label`, `wikidata:alt`, `osm:name`, `osm:name:<lang>`, `overture:name`, `derived:head-noun`, or `seed`.
	 */
	source: string
	/**
	 * Whether a human has approved this surface for parsing use IN ITS REGION. Everything machine-derived starts `false`
	 * and is flipped only by a matching {@link SubVenuePromotion}. A consumer that gates a parse MUST filter on this — see
	 * `sub-venue-lexicon.ts`'s module docstring for what a promotion decides and why it is per-locale.
	 */
	curated: boolean
	/**
	 * How many source features attested this exact phrase, when the source counts (OSM, Overture). `0` for vocabulary
	 * sources, which attest a term's EXISTENCE rather than its frequency.
	 */
	observations: number
	/**
	 * The rule-assigned designator of the FEATURES that carried this phrase, with a count each — `platform:3205
	 * campus:49` for GB's `hall`. Empty for vocabulary sources.
	 *
	 * This is the confound axis. A `hall` on a `platform` row is a British bus stop named after a village hall; a `hall`
	 * on a `terminal` row is a real German departure hall. Without it, a surface's `observations` count is a magnitude
	 * with no sign — see the repo's "meaning of zero" rule, which applies just as hard to a large number.
	 */
	context: Record<string, number>
}

/**
 * The measured shape of a designator's identifier half — what follows `Gate`/`Terminal` in real data.
 *
 * Derived from OSM `ref` values, NOT from names, and that is why the artifact has a section for it at all. Every one of
 * Berlin's 26 `aeroway=gate` features is unnamed and carries only a `ref`: `13`, `6`, `0/1`, `14/15`, `16-18`. So `Gate
 * A12` is a RENDERING (`<designator> <ref>`) rather than a string anyone has written down, and a shard that wants to
 * generate the designator+identifier form needs the identifier DISTRIBUTION, not a list of phrases.
 */
export interface IdentifierShape {
	designatorID: string
	/**
	 * ISO 3166-1 alpha-2 of the extract this distribution was measured in. Per-region because the shapes differ: GB gates
	 * are 70% bare digits, Japanese platform refs are overwhelmingly bare digits with a different range, and a shard that
	 * generates `Gate <ref>` for a French address should sample France's distribution.
	 */
	region: string
	/**
	 * A coarse class: `digit` (`5`), `letter` (`B`), `letter-digit` (`A12`), `digit-letter` (`2F`), `range` (`16-18`,
	 * `0/1`), or `other`.
	 */
	shape: string
	observations: number
	/**
	 * Up to eight real values, sorted, so a shard author can see what the class actually contains.
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
	 * Every curation decision taken against this table, promotion AND rejection, each with the census that backs it. A
	 * rejection is as required as a promotion: it is what stops the next reader re-proposing `hall` for en-GB.
	 */
	promotions: SubVenuePromotion[]
}

/**
 * The vocabulary that already ships in `neural/venue-structure.ts`, re-declared. See the module docstring for why this
 * duplication exists.
 *
 * `tier` is added here (the shipped list has no such field): the seven WOF placetypes plus `terminal`/`gate` are all
 * venue-INTERIOR, except `campus` and `building`, which name a whole venue as often as a part of one. They are marked
 * `subvenue` anyway, because that is the role the span proposer uses them in — `Building 43, Googleplex` is a unit
 * inside a venue.
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
 * Designators the lexicon ADDS beyond what ships, each with the source that attests it.
 *
 * `platform`, `station` and `airport` come from the OSM extractor's rule table and are the rail/aviation venue-side
 * vocabulary the corpus line needs. `hall` and `satellite` come from Wikidata concepts and from
 * `wof-osm-placetype-map.mdx`'s own "plausible additions" note, which lists `hall` explicitly. `pier` joins them in
 * wave 2 on 282 Overture attestations in the `pier` category plus 162 in the GB extract — the corpus task names `Pier
 * C` as a target shape, so the record has to exist before a shard can generate it.
 *
 * None is `modifierEligible`: that claim needs a confound board per term AND per locale, and `sub-venue-promotions.ts`
 * is where those live. A promotion marks a SURFACE usable; it does not widen the modifier grammar.
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
 * `designatorID` → Wikidata QID, mirroring `fetch/wikidata-subvenue.ts`'s `SUBVENUE_CONCEPTS`. Re-declared here so the
 * builder stays a pure function over PARSED input rather than reaching into a fetch module for a constant; the test
 * pins the two against each other.
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
