/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the sub-venue designator lexicon (#35) — the vocabulary a corpus shard and, eventually, the
 *   span proposer read to recognize `Terminal 5`, `North Terminal`, `Concourse B`, `ターミナル1` as
 *   venue-INTERIOR structure.
 *
 *   Reads the fetch outputs (`mailwoman corpus fetch wikidata-subvenue`, a JSONL of
 *   `@mailwoman/osm/sdk`'s `SubVenueSourceRow`s per region, and the Overture slice of `poi.db` via
 *   `overture-subvenue.ts`) and emits one committed JSON table. The shape follows
 *   `@mailwoman/poi-taxonomy`'s `taxonomy.json` idiom exactly — typed records plus a FLAT phrase array
 *   keyed back to a record id, which is what makes a longest-match phrase index cheap to build over it.
 *   {@link SubVenueSurface} is this table's `SynonymEntry`.
 *
 *   ── Determinism ──────────────────────────────────────────────────────────────────────────────────
 *   {@link buildSubVenueLexicon} is a PURE function of its inputs with a stable sort on every array, so
 *   a regenerate against the same fetch outputs is byte-identical. No timestamp is emitted for the same
 *   reason `taxonomy.json` carries none — a clock in the artifact makes every regenerate a diff.
 *   Vintages live in `sources[]`, taken from the fetch manifests.
 *
 *   ── The findings this build is SHAPED BY, all measured ───────────────────────────────────────────
 *
 *   **1. A feature's `name` is usually the VENUE's name, not a sub-venue phrase.** Measured on the
 *   Berlin extract (2,060 matched features, 2026-08-04): a `railway=platform` is named `Stendaler
 *   Straße`, a `railway=station` is named `Bellevue`, an `amenity=university` is named `Hertie School`.
 *   Across 250,116 named Great Britain features only 6,003 (2.40%) contain a designator token at all.
 *   So names are NOT harvested wholesale — {@link extractAttestedPhrases} keeps a name only when it
 *   CONTAINS a known designator surface, which is what makes `Terminal E (Untere Ebene)` evidence and
 *   `Otto Lilienthal Flughafen Berlin Tegel` not.
 *
 *   **2. The identifier lives in `ref`, not in `name`.** Every one of Berlin's 26 `aeroway=gate`
 *   features is unnamed and carries only a `ref`: `13`, `6`, `0/1`, `14/15`, `16-18`. That means
 *   `Gate A12` is a RENDERING (`<designator> <ref>`) rather than a string anyone has written down, and a
 *   shard that wants to generate the designator+identifier form needs the identifier DISTRIBUTION, not
 *   a list of phrases. {@link IdentifierShape} is that distribution, and it is why the artifact has a
 *   section for it at all.
 *
 *   **3. A matched phrase belongs to the record the PHRASE names, not to the record the ROW carries.**
 *   Wave 1 attributed every hit to `row.designatorID`, which is the rule that matched the FEATURE. On
 *   the GB extract that produced `west → platform`, `hall → platform`, `biggin → platform` — 108 of 133
 *   OSM-derived surfaces had a `phrase` that named a different record than the one they pointed at,
 *   because a bus stop tagged `public_transport=platform` is named "Village Hall" or "West Kensington".
 *   {@link extractAttestedPhrases} now takes a phrase → record INDEX and attributes by phrase; the row's
 *   own designator is kept as `context`, which is exactly the axis a confound board needs (a `hall` seen
 *   on a platform is a confound; a `hall` seen on a terminal is evidence).
 *
 *   ── What `curated: false` means, and how a surface stops being it ────────────────────────────────
 *   Wikidata gives a CONCEPT NAME per language, not a designator as addressed. Q849706's Spanish label
 *   is `terminal aeroportuaria`; the addressed form is `Terminal`. Q240854 (`hall`) is `sala` in
 *   Italian, which names an ordinary room and would fire on half of Italy. So every machine-derived
 *   surface lands `curated: false`, and {@link SubVenueLexiconTable} consumers that gate parsing MUST
 *   filter to `curated: true`.
 *
 *   A surface becomes curated ONLY by matching a {@link SubVenuePromotion} in
 *   `sub-venue-promotions.ts` — a per-designator, per-LOCALE decision carrying the census that backs
 *   it. Promotion is per-locale because the same token is a designator in one language and a disaster
 *   in another: `hall` is `Halle 2` at Frankfurt and `Village Hall` at 3,205 British bus stops.
 *
 *   ── The seed DUPLICATES `neural/venue-structure.ts`, knowingly ───────────────────────────────────
 *   `@mailwoman/corpus` does not depend on `@mailwoman/neural` (the dependency runs the other way for
 *   the training path, and pulling onnxruntime into a corpus build to read three string arrays would be
 *   absurd), so the shipped vocabulary is re-declared below. That is a drift surface and it is stated
 *   rather than hidden: `sub-venue-lexicon.test.ts` pins the seed's contents literally, so a change in
 *   either place fails a test rather than passing silently.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { TextSpliterator } from "spliterator"

import { SUBVENUE_PROMOTIONS, type SubVenuePromotion } from "./sub-venue-promotions.ts"

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
	 * A SUBSET, and the exclusions are load-bearing: `gate` and `building` form ordinary STREET names in exactly this
	 * shape ("East Gate" is a real GB street, "Building Society Place" is a real street), so admitting them turns a
	 * correct street parse into a sub-venue one. Setting this true means claiming no street is named `<modifier> <id>`.
	 * Check before you do.
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
	 * The phrase, lowercased for Latin-script languages and left as written otherwise (case-folding is meaningless for
	 * Japanese, and `toLowerCase` on Turkish `I` is actively wrong).
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
	 * the module docstring.
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
 * Derived from OSM `ref` values, not from names. See the module docstring's finding 2.
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
	 * rejection is as load-bearing as a promotion: it is what stops the next reader re-proposing `hall` for en-GB.
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

/**
 * How many real `ref` values each {@link IdentifierShape} keeps.
 *
 * Eight, not "all" and not one. The field exists so a shard author can see what a class actually CONTAINS — GB's
 * `other` class turned out to be semicolon multi-values (`1;2;3`, `13;14`), which one example would have hidden and
 * which the class name does not say. Eight fits a terminal line and covers the variety inside every class the GB
 * extract produced. The COUNT lives in `observations`; this is a sample, not a census.
 */
const IDENTIFIER_EXAMPLES_PER_SHAPE = 8

/**
 * Scripts whose case is meaningful to fold. Everything else is left as written — see {@link SubVenueSurface.phrase}.
 */
const CASE_FOLDING_SCRIPT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d\s\p{P}]+$/u

/**
 * Scripts written without spaces between words, where a token split cannot find a designator and a SUBSTRING test is
 * the correct operator. Han, Hiragana, Katakana; Hangul is excluded because Korean does space its words.
 *
 * The Germanic-compound argument that keeps {@link nameContainsSurface} token-bounded for Latin script does not transfer
 * here — there is no `-gate`/`-hall` street-name suffix class in Japanese, and `第1ターミナル` is unreachable by any token
 * split. Measured on the Japan extract: see the harvest counts in `corpus/data/PROVENANCE.md`.
 */
const NON_SPACING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * Normalize a surface for the table: trim, collapse internal whitespace, and lowercase ONLY when the string is entirely
 * in a bicameral script. `ターミナルビル` and `航站楼` pass through untouched; `Flughafenterminal` folds.
 */
export function normalizeSurface(text: string): string {
	const trimmed = text.trim().replaceAll(/\s+/gu, " ")

	return CASE_FOLDING_SCRIPT.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/**
 * The SPARQL results envelope, narrowed to the columns the designator-label query produces.
 */
interface SPARQLBinding {
	item?: { value: string }
	lang?: { value: string }
	label?: { value: string }
	kind?: { value: string }
}

interface SPARQLEnvelope {
	results?: { bindings?: SPARQLBinding[] }
}

/**
 * Turn the Wikidata designator-label payload into surfaces.
 *
 * A row is dropped when its language tag is empty (an untagged literal, which Wikidata occasionally carries), when the
 * QID maps to no designator in {@link CONCEPT_QIDS}, or when the normalized phrase is empty. Everything that survives
 * lands `curated: false` — see the module docstring.
 */
export function surfacesFromWikidata(
	payload: unknown,
	conceptQIDs: Readonly<Record<string, string>> = CONCEPT_QIDS
): SubVenueSurface[] {
	const byQID = new Map(Object.entries(conceptQIDs).map(([id, qid]) => [qid, id]))
	const envelope = payload as SPARQLEnvelope
	const seen = new Set<string>()
	const out: SubVenueSurface[] = []

	for (const binding of envelope.results?.bindings ?? []) {
		const qid = binding.item?.value?.split("/").pop()
		const recordID = qid ? byQID.get(qid) : undefined
		const lang = binding.lang?.value
		const raw = binding.label?.value

		if (!recordID || !lang || !raw) continue

		const phrase = normalizeSurface(raw)

		if (!phrase) continue

		const source = binding.kind?.value === "alt" ? "wikidata:alt" : "wikidata:label"
		// A concept can carry the same string as both a label and an alias, and across dialect subtags
		// (`zh`, `zh-cn`, `zh-hans` all say 航站楼). Key the dedupe on the tuple that identifies a row.
		const key = `${phrase}\0${recordID}\0${lang}\0${source}`

		if (seen.has(key)) continue
		seen.add(key)

		out.push({
			phrase,
			recordID,
			recordKind: "designator",
			lang,
			region: "",
			source,
			curated: false,
			observations: 0,
			context: {},
		})
	}

	return out
}

/**
 * One row of a harvestable source, as read back off JSONL or out of a layer database.
 *
 * SOURCE-NEUTRAL by design, and verified so in wave 2: an Overture Places row from the `airport_terminal` category is
 * `{ designatorID, name }` and fits unchanged. What did NOT fit was the harvest function's hardcoded `osm:name` source
 * stamp — see `overture-subvenue.ts`'s docstring. Declared locally so the builder does not import `@mailwoman/osm`
 * (which `@mailwoman/corpus` does not depend on) just to name a shape it reads from a file.
 */
export interface SubVenueHarvestRow {
	/**
	 * The designator the SOURCE's rule assigned to the FEATURE. Not necessarily the record a matched phrase names — see
	 * the module docstring's finding 3. Carried into {@link SubVenueSurface.context}.
	 */
	designatorID: string
	name?: string | null
	ref?: string | null
	localizedNames?: Record<string, string>
}

/**
 * Classify an OSM `ref` into an {@link IdentifierShape} class.
 *
 * The classes are the ones Berlin's gates actually produced, plus the two aviation forms the corpus task names
 * (`Terminal 2F` is digit-letter, `Concourse B` is letter). `range` covers both separators OSM uses for a gate serving
 * more than one stand: `16-18` and `0/1`.
 */
export function classifyIdentifier(ref: string): string {
	const value = ref.trim()

	if (/^[0-9]+$/.test(value)) return "digit"

	if (/^[A-Za-z]$/.test(value)) return "letter"

	if (/^[A-Za-z]+[0-9]+$/.test(value)) return "letter-digit"

	if (/^[0-9]+[A-Za-z]+$/.test(value)) return "digit-letter"

	if (/^[0-9A-Za-z]+\s*[-/]\s*[0-9A-Za-z]+$/.test(value)) return "range"

	return "other"
}

/**
 * A phrase → record index, keyed on the normalized phrase. Built by {@link buildSurfaceIndex} from the surfaces present
 * before the harvest runs, and the reason a matched phrase can be attributed to the record it actually names.
 */
export type SurfaceIndex = ReadonlyMap<string, { recordID: string; recordKind: "designator" | "modifier" }>

/**
 * Index the surfaces accumulated so far by phrase. First writer wins, so a seed record beats a Wikidata alias that
 * happens to collide — `terminal` stays the `terminal` designator even though it is also an Italian alias for it.
 */
export function buildSurfaceIndex(surfaces: readonly SubVenueSurface[]): SurfaceIndex {
	const index = new Map<string, { recordID: string; recordKind: "designator" | "modifier" }>()

	for (const surface of surfaces) {
		if (index.has(surface.phrase)) continue
		index.set(surface.phrase, { recordID: surface.recordID, recordKind: surface.recordKind })
	}

	return index
}

/**
 * Every known phrase found in `name`, as whole-token runs for spacing scripts and as substrings for non-spacing ones.
 *
 * Token-boundary matching for Latin script, not substring: `Nordterminal` is a real German compound in which `terminal`
 * is a suffix, and a substring test would also fire on `Terminalstraße`. The compound case is a genuine miss and it is
 * the right miss — admitting suffix matches would fire on every `-hall`/`-gate` compound in Germanic and Nordic street
 * naming, which is exactly the confound class `Briggate`/`Kirkgate` represents.
 *
 * For Han/Kana names that rule finds nothing at all, because the script has no word boundaries: `第1ターミナル` splits into
 * one token that matches no surface. There the LONGEST known substring is the correct operator, and the compound
 * objection does not transfer — Japanese has no `-gate` street-name suffix class.
 */
export function nameContainsSurfaces(name: string, index: SurfaceIndex): string[] {
	const normalized = normalizeSurface(name)
	const hits = new Set<string>()

	for (const token of normalized.split(/[\s,()/]+/u)) {
		const stripped = token.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

		if (stripped && index.has(stripped)) {
			hits.add(stripped)
		}
	}

	if (NON_SPACING_SCRIPT.test(normalized)) {
		for (const [phrase] of index) {
			if (NON_SPACING_SCRIPT.test(phrase) && normalized.includes(phrase)) {
				hits.add(phrase)
			}
		}
	}

	return [...hits]
}

/**
 * Options for one harvest pass — which source stamp its surfaces carry and which region they were attested in.
 *
 * Both default to the OSM/unknown-region values wave 1 hardcoded, so an existing caller is unchanged.
 */
export interface HarvestOptions {
	/**
	 * Source family: `osm` yields `osm:name` / `osm:name:<lang>`, `overture` yields `overture:name`.
	 */
	source?: string
	/**
	 * ISO 3166-1 alpha-2 of the extract or partition. `""` when unknown.
	 */
	region?: string
}

/**
 * Harvest attested phrases and identifier shapes out of a source's rows.
 *
 * `index` gates the name harvest — a name contributes only when it CONTAINS a phrase already in the table. That filter
 * is the whole reason this function is safe to run over raw OSM: see the module docstring's finding 1 for the Berlin
 * measurement that motivated it. The index also decides ATTRIBUTION (finding 3): a hit is a surface of the record the
 * PHRASE names, and the row's own designator is recorded as `context`.
 *
 * Returns surfaces with real `observations` counts, so the lexicon can rank `terminal` above a phrase attested once.
 */
export function extractAttestedPhrases(
	rows: Iterable<SubVenueHarvestRow>,
	index: SurfaceIndex,
	options: HarvestOptions = {}
): { surfaces: SubVenueSurface[]; identifierShapes: IdentifierShape[] } {
	const source = options.source ?? "osm"
	const region = options.region ?? ""
	/**
	 * `phrase\0lang\0source` → { count, context }.
	 */
	const surfaceCounts = new Map<string, { count: number; context: Map<string, number> }>()
	/**
	 * `designatorID\0shape` → { count, examples }.
	 */
	const shapes = new Map<string, { count: number; examples: Set<string> }>()

	const note = (phrase: string, lang: string, sourceTag: string, context: string): void => {
		const key = `${phrase}\0${lang}\0${sourceTag}`
		const entry = surfaceCounts.get(key) ?? { count: 0, context: new Map<string, number>() }

		entry.count++
		entry.context.set(context, (entry.context.get(context) ?? 0) + 1)
		surfaceCounts.set(key, entry)
	}

	for (const row of rows) {
		if (row.name) {
			for (const hit of nameContainsSurfaces(row.name, index)) {
				// `und` — the default `name` tag carries no language. Overture's `name` is the same: a
				// primary name in whatever language the place uses, untagged.
				note(hit, "und", `${source}:name`, row.designatorID)
			}
		}

		for (const [lang, localized] of Object.entries(row.localizedNames ?? {})) {
			for (const hit of nameContainsSurfaces(localized, index)) {
				note(hit, lang, `${source}:name:${lang}`, row.designatorID)
			}
		}

		if (row.ref) {
			const shape = classifyIdentifier(row.ref)
			const key = `${row.designatorID}\0${shape}`
			const entry = shapes.get(key) ?? { count: 0, examples: new Set<string>() }

			entry.count++

			if (entry.examples.size < IDENTIFIER_EXAMPLES_PER_SHAPE) {
				entry.examples.add(row.ref.trim())
			}

			shapes.set(key, entry)
		}
	}

	const surfaces: SubVenueSurface[] = [...surfaceCounts].map(([key, entry]) => {
		const [phrase, lang, sourceTag] = key.split("\0") as [string, string, string]
		const record = index.get(phrase)!

		return {
			phrase,
			recordID: record.recordID,
			recordKind: record.recordKind,
			lang,
			region,
			source: sourceTag,
			curated: false,
			observations: entry.count,
			context: Object.fromEntries([...entry.context].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
		}
	})

	const identifierShapes: IdentifierShape[] = [...shapes].map(([key, entry]) => {
		const [designatorID, shape] = key.split("\0") as [string, string]

		return {
			designatorID,
			region,
			shape,
			observations: entry.count,
			examples: [...entry.examples].toSorted((a, b) => a.localeCompare(b)),
		}
	})

	return { surfaces, identifierShapes }
}

/**
 * Diacritic-flattened ASCII fold, for comparing a Slavic or Turkish inflection against its Latin root.
 */
function asciiFold(text: string): string {
	return text
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
}

/**
 * How many leading characters two ASCII-folded forms must share for one to count as the other's inflection.
 *
 * Five, or the id's own length when that is shorter (`hall`, `gate`, `wing`, `pier` are four). Measured against the
 * committed Wikidata pull: at five, `terminal`/`terminál`/`terminale`/`terminali`/`terminála`/`terminalo` are all
 * accepted for `terminal` while `campo` and `campws` are both rejected for `campus` (they share four). At six the
 * Spanish `satélite` is lost; at four, Italian `campo` is admitted and it means FIELD.
 */
const HEAD_NOUN_PREFIX_FLOOR = 5

/**
 * The shortest substring a non-Latin head-noun candidate may be. Two: `航站` and `터미널` are both real, `楼` alone is
 * "building" and would fire on every Chinese building name.
 */
const NON_LATIN_HEAD_MIN_LENGTH = 2

/**
 * How many head-noun candidates one non-Latin record+language group may contribute. Six — enough to carry `ターミナル`,
 * `ターミナルビル` and `旅客ターミナル` together, capped because the substring lattice of a nine-character label is large and, ranked
 * by attesting-surface count, nothing past the sixth has more than the minimum two.
 */
const NON_LATIN_HEAD_CANDIDATE_CAP = 6

/**
 * Latin-script test — the scripts an ASCII-folded prefix comparison against a Latin designator id can work on.
 */
const LATIN_PHRASE = /^[\p{Script=Latin}\d\s\p{P}]+$/u

/**
 * The scripts the shared-substring derivation is allowed to run on: Han, Hiragana, Katakana, Hangul.
 *
 * NARROWER than "not Latin", and the narrowing was earned. Run over every non-Latin phrase in the table, the derivation
 * produced 90 fragments of Cyrillic, Greek, Arabic, Thai, Burmese and Tamil words — `сгра`, `град`, `κτίρ`,
 * `ิ่งก่อสร้า` — because those languages have exactly one surface per concept and the only substrings shared inside a
 * group are pieces of one word. Every one of them was unusable, and none could ever be counted: `poi.db` is four
 * countries and this wave's extracts are GB, DE, FR, ES and JP, so nothing in reach attests a Thai or Burmese surface.
 * Deriving a candidate no available source can confirm is not a hypothesis, it is table weight.
 */
const SHARED_SUBSTRING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Derive the HEAD NOUN of every multi-part surface, so `terminal aeroportuaria` contributes the form anyone actually
 * writes on an envelope.
 *
 * The problem this solves is the whole reason wave 1 shipped 1,014 uncurated surfaces: Wikidata's label for a concept
 * is the ENCYCLOPAEDIC name (`terminal aeroportuaria`, `letištní terminál`, `havalimanı terminali`), while the
 * addressed form is the bare head (`Terminal`, `Terminál`, `Terminali`). Nothing can promote the encyclopaedic form, so
 * the head has to be extracted before the curation pass has anything to decide about.
 *
 * Two derivations, because the table holds two kinds of writing:
 *
 * - **Latin script — the COGNATE test.** A token is the head when its ASCII fold shares {@link HEAD_NOUN_PREFIX_FLOOR}
 *   leading characters with the designator's own canonical id. Nothing subtler survived contact with the data: an
 *   earlier version matched a token against any SINGLE-TOKEN surface of the record, and because Dutch `universiteit` is
 *   a one-token surface of `campus`, it derived `universitario`, `universitaire`, `üniversite` and twenty more as head
 *   nouns of `campus`. Those are the MODIFIER half of the label, and admitting them would have taught the harvest to
 *   read "Ciudad Universitaria" as sub-venue structure.
 * - **Non-Latin script — the SHARED-SUBSTRING test.** The cognate test cannot reach a script the id is not written in,
 *   and for Han and Kana a token split finds nothing at all. So every substring of length ≥
 *   {@link NON_LATIN_HEAD_MIN_LENGTH} occurring in at least two DISTINCT surfaces of the same record and primary
 *   language becomes a candidate, ranked by how many surfaces carry it. Japanese yields `ターミナル` (in all five `ja`
 *   terminal labels) ahead of `ターミナルビル` (three); Chinese yields `航站`, `航站楼`, `航站樓`. Where the script DOES space its
 *   words (Korean, Greek, Cyrillic) a candidate must be a whole token, so `공항 터미널` ∩ `공항터미널` gives `터미널` and never a
 *   fragment.
 *
 * The non-Latin branch deliberately emits SEVERAL candidates instead of picking one. Choosing between `航站` and `航站楼`
 * from Wikidata alone is guesswork; the Japan extract answers it by counting, and the promotion ledger records which
 * count won. Everything derived lands `curated: false` — the derivation is a hypothesis about what the addressed form
 * is, and a locale's own data is what confirms or kills it.
 */
export function deriveHeadNounSurfaces(surfaces: readonly SubVenueSurface[]): SubVenueSurface[] {
	const derived = new Map<string, SubVenueSurface>()
	const seen = new Set(surfaces.map((s) => `${s.phrase}\0${s.recordID}\0${s.lang}`))

	const emit = (phrase: string, from: SubVenueSurface): void => {
		if (phrase === from.phrase) return

		const key = `${phrase}\0${from.recordID}\0${from.lang}`

		if (seen.has(key) || derived.has(key)) return

		derived.set(key, {
			phrase,
			recordID: from.recordID,
			recordKind: from.recordKind,
			lang: from.lang,
			region: "",
			source: "derived:head-noun",
			curated: false,
			observations: 0,
			context: {},
		})
	}

	// ── Spacing scripts: prefix-match a token against a single-token surface of the same record ──────
	// Latin script: a token that is a cognate of the designator's own canonical id.
	for (const surface of surfaces) {
		if (!LATIN_PHRASE.test(surface.phrase)) continue

		const parts = surface.phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

		if (parts.length < 2) continue

		const root = asciiFold(surface.recordID)
		const floor = Math.min(HEAD_NOUN_PREFIX_FLOOR, root.length)

		for (const part of parts) {
			const folded = asciiFold(part)

			if (folded.length >= floor && commonPrefixLength(folded, root) >= floor) {
				emit(part, surface)
			}
		}
	}

	// Non-Latin script: substrings shared by two or more surfaces of the same record + language.
	const groups = new Map<string, Set<string>>()

	for (const surface of surfaces) {
		if (!SHARED_SUBSTRING_SCRIPT.test(surface.phrase)) continue

		// Group `zh`, `zh-cn`, `zh-hant` together: they are writing systems for one vocabulary, and the
		// simplified/traditional pair is exactly the evidence a shared substring needs.
		const key = `${surface.recordID} ${surface.lang.split(/[-_]/u)[0]!}`
		const pool = groups.get(key) ?? new Set<string>()
		pool.add(surface.phrase)
		groups.set(key, pool)
	}

	const candidatesByGroup = new Map<string, string[]>()

	for (const [key, pool] of groups) {
		if (pool.size < 2) continue
		candidatesByGroup.set(key, sharedSubstringCandidates(pool))
	}

	for (const surface of surfaces) {
		if (!SHARED_SUBSTRING_SCRIPT.test(surface.phrase)) continue

		const key = `${surface.recordID} ${surface.lang.split(/[-_]/u)[0]!}`

		for (const candidate of candidatesByGroup.get(key) ?? []) {
			if (surface.phrase.includes(candidate)) {
				emit(candidate, surface)
			}
		}
	}

	return [...derived.values()]
}

/**
 * Length of the shared leading run of two strings.
 */
function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length)
	let i = 0

	while (i < limit && a[i] === b[i]) {
		i++
	}

	return i
}

/**
 * Substrings occurring in at least two DISTINCT members of `pool`, ranked by that count and then by length, capped at
 * {@link NON_LATIN_HEAD_CANDIDATE_CAP}.
 *
 * A candidate never spans whitespace, and in a pool whose members contain whitespace a candidate must be a whole token
 * of some member. That is what keeps Korean `공항 터미널` from contributing a fragment straddling the space.
 *
 * MAXIMAL candidates only: one contained in a longer candidate carried by the SAME number of surfaces is dropped, since
 * counting can never separate the two. Every one of `ターミナル`'s five ja labels also contains `ターミ`, `ターミナ` and `ミナル`, so
 * without this the group contributes four indistinguishable candidates and the Japan harvest returns four identical
 * counts. `航站` survives next to `航站楼` because six surfaces carry it against that one's two.
 */
function sharedSubstringCandidates(pool: ReadonlySet<string>): string[] {
	const phrases = [...pool]
	const spaced = phrases.some((phrase) => /\s/u.test(phrase))
	const tokens = spaced ? new Set(phrases.flatMap((phrase) => phrase.split(/\s+/u).filter(Boolean))) : null
	const counts = new Map<string, number>()

	for (const phrase of phrases) {
		const local = new Set<string>()

		for (let length = NON_LATIN_HEAD_MIN_LENGTH; length <= phrase.length; length++) {
			for (let start = 0; start + length <= phrase.length; start++) {
				const candidate = phrase.slice(start, start + length)

				if (/\s/u.test(candidate)) continue
				local.add(candidate)
			}
		}

		for (const candidate of local) {
			counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
		}
	}

	const kept = [...counts].filter(([candidate, count]) => count >= 2 && (!tokens || tokens.has(candidate)))

	return kept
		.filter(([candidate, count]) =>
			kept.every(([other, otherCount]) => other === candidate || otherCount !== count || !other.includes(candidate))
		)
		.toSorted((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
		.slice(0, NON_LATIN_HEAD_CANDIDATE_CAP)
		.map(([candidate]) => candidate)
}

/**
 * Apply the curation decisions to a surface list, IN PLACE on a copy.
 *
 * A promotion binds `(designatorID, phrase, locale)`. A surface matches when it names the same record with the same
 * phrase and its language is the locale's language OR the untagged `und` — the default `name` tag carries no language,
 * and a German extract's untagged `Halle 2` is German.
 *
 * REGION is the subtle half. A surface attested in an extract carries that extract's region and matches only its own
 * locale. A surface with `region: ""` is region-FREE — a Wikidata label or a derived head noun — and a promotion
 * reaches it only when no REJECTION exists for the same designator, phrase and language anywhere else. That guard is
 * not decoration: `pier` is promoted for en-GB and rejected for en-US, and without it the en-GB decision would curate
 * the region-free English surface and hand `Pier 1 Imports` the promotion en-US was refused. Where no rejection
 * competes — `terminal` in `es`, `ターミナル` in `ja` — the region-free surface is the whole point, since a language's
 * designator does not stop at a border.
 *
 * Rejections mark nothing themselves. They exist in `promotions[]` as the record of a decision taken, so the next
 * reader meets en-GB `hall`'s 3,204 bus stops before re-proposing it, not after.
 */
export function applyPromotions(
	surfaces: readonly SubVenueSurface[],
	promotions: readonly SubVenuePromotion[]
): SubVenueSurface[] {
	const language = (locale: string): string => locale.split("-")[0]!
	const region = (locale: string): string => locale.split("-")[1] ?? ""

	const rejectedLanguages = new Set(
		promotions
			.filter((promotion) => promotion.decision === "reject")
			.map((promotion) => `${promotion.designatorID} ${promotion.phrase} ${language(promotion.locale)}`)
	)

	const promoted = promotions.filter((promotion) => promotion.decision === "promote")

	return surfaces.map((surface) => {
		if (surface.curated) return surface

		const hit = promoted.some((promotion) => {
			if (promotion.designatorID !== surface.recordID || promotion.phrase !== surface.phrase) return false

			const lang = language(promotion.locale)

			if (surface.lang !== lang && surface.lang !== "und") return false

			if (surface.region === region(promotion.locale)) return true

			return surface.region === "" && !rejectedLanguages.has(`${promotion.designatorID} ${promotion.phrase} ${lang}`)
		})

		return hit ? { ...surface, curated: true } : surface
	})
}

/**
 * One harvestable input: rows plus the stamp they carry into the table.
 */
export interface SubVenueHarvest {
	rows: readonly SubVenueHarvestRow[]
	source?: string
	region?: string
}

/**
 * Everything {@link buildSubVenueLexicon} needs, already parsed. Keeping the builder off the filesystem is what makes it
 * deterministic and testable without fixtures on disk.
 */
export interface BuildSubVenueLexiconInput {
	/**
	 * The raw `designator-labels.json` SPARQL envelope, or `null` to build the seed-only table.
	 */
	wikidata: unknown | null
	/**
	 * Every harvestable source, in the order they should contribute. Order matters only for the surface INDEX: a source
	 * can match a phrase an earlier source introduced, never a later one.
	 */
	harvests: readonly SubVenueHarvest[]
	/**
	 * Provenance rows, copied off the fetch manifests by the caller.
	 */
	sources: readonly SubVenueLexiconSource[]
	/**
	 * Curation decisions. Defaults to the committed {@link SUBVENUE_PROMOTIONS}; pass an empty array to build the
	 * pre-curation table (which is what the promotion census itself is taken against).
	 */
	promotions?: readonly SubVenuePromotion[]
}

/**
 * Build the lexicon table. PURE and deterministic — same inputs, byte-identical output.
 *
 * Order of operations is load-bearing in three places:
 *
 * 1. Seed surfaces are inserted before anything else, so `terminal` indexes to the `terminal` designator rather than to
 *    whichever Wikidata alias sorts first.
 * 2. Head nouns are derived AFTER Wikidata and BEFORE the harvests, because `ターミナル` has to exist as a surface before a
 *    Japanese extract can be searched for it. That ordering is the entire reason the Japan harvest finds anything — see
 *    `PROVENANCE.md`.
 * 3. Promotions are applied LAST, over the union, so a decision can promote a surface whichever source produced it.
 */
export function buildSubVenueLexicon(input: BuildSubVenueLexiconInput): SubVenueLexiconTable {
	const designators: SubVenueDesignator[] = SHIPPED_DESIGNATOR_SEED.map((seed) => ({
		id: seed.id,
		tier: LexiconTier.SubVenue,
		modifierEligible: seed.modifierEligible,
		shipped: true,
		provenance: [...seed.provenance],
	}))

	const byID = new Map(designators.map((d) => [d.id, d]))

	for (const proposed of PROPOSED_DESIGNATORS) {
		const existing = byID.get(proposed.id)

		if (existing) {
			existing.provenance = [...new Set([...existing.provenance, ...proposed.provenance])]

			continue
		}

		const record: SubVenueDesignator = {
			id: proposed.id,
			tier: proposed.tier,
			modifierEligible: false,
			shipped: false,
			provenance: [...proposed.provenance],
		}

		designators.push(record)
		byID.set(record.id, record)
	}

	// A Wikidata concept id is provenance for the designator it names, whether or not the concept
	// contributed a usable surface.
	for (const [id, qid] of Object.entries(CONCEPT_QIDS)) {
		const record = byID.get(id)

		if (record) {
			record.provenance = [...new Set([...record.provenance, `wikidata:${qid}`])]
		}
	}

	const modifiers: SubVenueModifier[] = SHIPPED_MODIFIER_SEED.map((id) => ({
		id,
		shipped: true,
		provenance: ["codex:directionals"],
	}))

	const surfaces: SubVenueSurface[] = [
		...designators.map(
			(d): SubVenueSurface => ({
				phrase: d.id,
				recordID: d.id,
				recordKind: "designator",
				lang: "en",
				region: "",
				source: "seed",
				// The English designator IS the shipped vocabulary — curated by construction.
				curated: d.shipped,
				observations: 0,
				context: {},
			})
		),
		...modifiers.map(
			(m): SubVenueSurface => ({
				phrase: m.id,
				recordID: m.id,
				recordKind: "modifier",
				lang: "en",
				region: "",
				source: "seed",
				curated: true,
				observations: 0,
				context: {},
			})
		),
	]

	if (input.wikidata) {
		surfaces.push(...surfacesFromWikidata(input.wikidata))
	}

	surfaces.push(...deriveHeadNounSurfaces(surfaces))

	const identifierShapes: IdentifierShape[] = []

	for (const harvest of input.harvests) {
		const attested = extractAttestedPhrases(harvest.rows, buildSurfaceIndex(surfaces), {
			source: harvest.source,
			region: harvest.region,
		})

		surfaces.push(...attested.surfaces)
		identifierShapes.push(...attested.identifierShapes)
	}

	const promotions = [...(input.promotions ?? SUBVENUE_PROMOTIONS)]
	const curated = applyPromotions(surfaces, promotions)

	// Deterministic order everywhere. `localeCompare` matches the tie-break discipline
	// `generate-taxonomy.ts` and `build-brands.ts` already use.
	designators.sort((a, b) => a.id.localeCompare(b.id))
	modifiers.sort((a, b) => a.id.localeCompare(b.id))

	curated.sort(
		(a, b) =>
			a.phrase.localeCompare(b.phrase) ||
			a.recordID.localeCompare(b.recordID) ||
			a.lang.localeCompare(b.lang) ||
			a.region.localeCompare(b.region) ||
			a.source.localeCompare(b.source)
	)

	return {
		version: SUBVENUE_LEXICON_VERSION,
		sources: input.sources.toSorted((a, b) => a.id.localeCompare(b.id)),
		designators,
		modifiers,
		surfaces: curated,
		identifierShapes: identifierShapes.toSorted(
			(a, b) =>
				a.designatorID.localeCompare(b.designatorID) ||
				a.region.localeCompare(b.region) ||
				a.shape.localeCompare(b.shape)
		),
		promotions: promotions.toSorted(
			(a, b) =>
				a.designatorID.localeCompare(b.designatorID) ||
				a.locale.localeCompare(b.locale) ||
				a.phrase.localeCompare(b.phrase)
		),
	}
}

/**
 * Serialize the table the way the committed artifact stores it: pretty-printed, trailing newline. Run `oxfmt` over the
 * result before committing — repo law is that committed JSON is oxfmt-clean, which `JSON.stringify` cannot reproduce.
 */
export function serializeSubVenueLexicon(table: SubVenueLexiconTable): string {
	return JSON.stringify(table, null, 2) + "\n"
}

/**
 * Read a JSONL file of {@link SubVenueHarvestRow}s. Blank lines and unparseable rows are skipped rather than fatal — an
 * extract is a build output, and one malformed line should not cost the whole lexicon.
 */
export function readSubVenueJSONL(path: string): SubVenueHarvestRow[] {
	const out: SubVenueHarvestRow[] = []

	// `TextSpliterator` rather than `split("\n")` — a whole-country extract runs to 250,000 lines
	// (52 MB for Great Britain), and materializing every segment before reading the first is exactly
	// what the repo lint rule exists to prevent.
	for (const line of TextSpliterator.from(readFileSync(path, "utf8"))) {
		const trimmed = line.trim()

		if (!trimmed) continue

		try {
			out.push(parseJSONStrict<SubVenueHarvestRow>(trimmed))
		} catch {
			continue
		}
	}

	return out
}

/**
 * The Wikidata fetch manifest's shape, narrowed to the fields the lexicon copies into `sources[]`.
 */
interface WikidataFetchManifest {
	endpoint?: string
	license?: string
	downloaded_at?: string
	files?: Array<{ filename?: string; rows?: number }>
}

/**
 * One OSM extract to harvest: the JSONL path plus the ISO country its rows describe.
 */
export interface SubVenueExtractInput {
	path: string
	region: string
}

export interface GenerateSubVenueLexiconOptions {
	/**
	 * Directory holding the `mailwoman corpus fetch wikidata-subvenue` output. Omit to build the seed-only table.
	 */
	wikidataDir?: string
	/**
	 * OSM extract JSONLs, one per region.
	 */
	extracts?: readonly SubVenueExtractInput[]
	/**
	 * Already-read Overture rows (`readOvertureSubVenues`), grouped by the caller. Kept as a parameter rather than a path
	 * so this function stays free of a 3.9 GB database dependency — the CLI opens `poi.db`, this assembles.
	 */
	overtureRows?: readonly (SubVenueHarvestRow & { country: string })[]
	/**
	 * `poi.db`'s layer vintage, for `sources[]`. Only read when `overtureRows` is non-empty.
	 */
	overtureVintage?: string
	/**
	 * Where the table is written.
	 */
	outPath: string
}

/**
 * Read the fetch outputs, build the table, and write it.
 *
 * The IO half only — every decision lives in {@link buildSubVenueLexicon}, which is pure. Run `oxfmt` over `outPath`
 * afterwards; repo law is that committed JSON is oxfmt-clean.
 */
export function generateSubVenueLexicon(options: GenerateSubVenueLexiconOptions): SubVenueLexiconTable {
	const sources: SubVenueLexiconSource[] = []
	const harvests: SubVenueHarvest[] = []
	let wikidata: unknown = null

	if (options.wikidataDir) {
		wikidata = parseJSONStrict<unknown>(readFileSync(join(options.wikidataDir, "designator-labels.json"), "utf8"))

		const manifest = parseJSONStrict<WikidataFetchManifest>(
			readFileSync(join(options.wikidataDir, "MANIFEST.json"), "utf8")
		)

		const labelFile = manifest.files?.find((f) => f.filename === "designator-labels.json")

		sources.push({
			id: "wikidata",
			origin: manifest.endpoint ?? "https://query.wikidata.org/sparql",
			license: manifest.license ?? "CC0",
			// The DATE only. A full ISO timestamp would make every re-fetch a diff in the committed artifact for
			// no information a reader of a vocabulary table can act on.
			retrieved: (manifest.downloaded_at ?? "").slice(0, 10),
			rows: labelFile?.rows ?? 0,
		})
	}

	for (const extract of options.extracts ?? []) {
		const rows = readSubVenueJSONL(extract.path)

		harvests.push({ rows, source: "osm", region: extract.region })

		sources.push({
			id: `osm:${extract.region.toLowerCase()}`,
			// The extract's NAME, never its path. `AGENTS.md` forbids re-hardcoding the lab data root
			// anywhere, and a committed artifact carrying `/mnt/playpen/...` would do exactly that while
			// telling a reader on another machine nothing. `great-britain` identifies the Geofabrik region,
			// which is the fact that matters.
			origin: `OpenStreetMap via Geofabrik (${basename(extract.path, ".jsonl")})`,
			license: "ODbL (OpenStreetMap)",
			// The extract's mtime — when the rows were produced. `corpus/AGENTS.md`'s standing warning that
			// a file's mtime is not its DATA's vintage applies to a downloaded archive; this file is a build
			// output of ours, so its mtime is exactly the right number.
			retrieved: statSync(extract.path).mtime.toISOString().slice(0, 10),
			rows: rows.length,
		})
	}

	if (options.overtureRows?.length) {
		// Overture rows carry their own country, so they are harvested per REGION rather than in one pass —
		// a `region` on the surface is the axis promotion is decided on and a mixed-country bucket would
		// make it meaningless.
		const byCountry = new Map<string, SubVenueHarvestRow[]>()

		for (const row of options.overtureRows) {
			const bucket = byCountry.get(row.country) ?? []
			bucket.push(row)
			byCountry.set(row.country, bucket)
		}

		for (const [country, rows] of [...byCountry].toSorted((a, b) => a[0].localeCompare(b[0]))) {
			harvests.push({ rows, source: "overture", region: country })
		}

		sources.push({
			id: "overture",
			origin: "Overture Maps Foundation places, via the poi.db spatial layer",
			license: "CDLA-Permissive-2.0",
			retrieved: options.overtureVintage ?? "",
			rows: options.overtureRows.length,
		})
	}

	const table = buildSubVenueLexicon({ wikidata, harvests, sources })
	writeFileSync(options.outPath, serializeSubVenueLexicon(table))

	return table
}
