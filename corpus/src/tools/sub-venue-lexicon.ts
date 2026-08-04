/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the sub-venue designator lexicon (#35 wave 1) — the vocabulary a corpus shard and,
 *   eventually, the span proposer read to recognize `Terminal 5`, `North Terminal`, `Concourse B`,
 *   `ターミナル1` as venue-INTERIOR structure.
 *
 *   Reads the fetch outputs (`mailwoman corpus fetch wikidata-subvenue`, plus an optional JSONL of
 *   `@mailwoman/osm/sdk`'s `SubVenueSourceRow`s) and emits one committed JSON table. The shape follows
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
 *   ── The two findings this build is SHAPED BY, both measured ──────────────────────────────────────
 *
 *   **1. An OSM feature's `name` is usually the VENUE's name, not a sub-venue phrase.** Measured on the
 *   Berlin extract (2,060 matched features, 2026-08-04): a `railway=platform` is named `Stendaler
 *   Straße`, a `railway=station` is named `Bellevue`, an `amenity=university` is named `Hertie School`.
 *   The designator word appears in almost none of them. So names are NOT harvested wholesale as
 *   surfaces — {@link extractAttestedPhrases} keeps a name only when it CONTAINS a known designator
 *   surface, which is what makes `Terminal E (Untere Ebene)` evidence and `Otto Lilienthal Flughafen
 *   Berlin Tegel` not. Harvesting wholesale would have filled the lexicon with German street names.
 *
 *   **2. The identifier lives in `ref`, not in `name`.** Every one of Berlin's 26 `aeroway=gate`
 *   features is unnamed and carries only a `ref`: `13`, `6`, `0/1`, `14/15`, `16-18`. That means
 *   `Gate A12` is a RENDERING (`<designator> <ref>`) rather than a string anyone has written down, and a
 *   shard that wants to generate the designator+identifier form needs the identifier DISTRIBUTION, not
 *   a list of phrases. {@link IdentifierShape} is that distribution, and it is why the artifact has a
 *   section for it at all.
 *
 *   ── What `curated: false` means, and why nothing auto-promotes ───────────────────────────────────
 *   Wikidata gives a CONCEPT NAME per language, not a designator as addressed. Q849706's Spanish label
 *   is `terminal aeroportuaria`; the addressed form is `Terminal`. Q240854 (`hall`) is `sala` in
 *   Italian, which names an ordinary room and would fire on half of Italy. So every Wikidata-derived
 *   surface lands `curated: false`, and {@link SubVenueLexiconTable} consumers that gate parsing MUST
 *   filter to `curated: true`. The curated set is seeded from what already ships (see
 *   {@link SHIPPED_DESIGNATOR_SEED}) and grows by human review, one confound board at a time — the same
 *   discipline `MODIFIER_ELIGIBLE_STRUCTURE_DESIGNATORS` already applies to `gate` and `building`.
 *
 *   ── The seed DUPLICATES `neural/venue-structure.ts`, knowingly ───────────────────────────────────
 *   `@mailwoman/corpus` does not depend on `@mailwoman/neural` (the dependency runs the other way for
 *   the training path, and pulling onnxruntime into a corpus build to read three string arrays would be
 *   absurd), so the shipped vocabulary is re-declared below. That is a drift surface and it is stated
 *   rather than hidden: `sub-venue-lexicon.test.ts` pins the seed's contents literally, so a change in
 *   either place fails a test rather than passing silently. Wave 2's right move is the reverse
 *   direction — have `neural/venue-structure.ts` read a committed lexicon slice and delete both lists.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { TextSpliterator } from "spliterator"

/**
 * This table's own data version. Bump when the source vintages or the build semantics change.
 */
export const SUBVENUE_LEXICON_VERSION = "0.1.0"

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
	 * `wikidata:Q849706`. Sorted, so a regenerate is stable.
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
	 * BCP-47-ish language subtag as the source wrote it (`en`, `ja`, `zh-Hant`, `pt-BR`).
	 */
	lang: string
	/**
	 * `wikidata:label`, `wikidata:alt`, `osm:name`, `osm:name:<lang>`, or `seed`.
	 */
	source: string
	/**
	 * Whether a human has approved this surface for parsing use. Everything machine-derived starts `false`. A consumer
	 * that gates a parse MUST filter on this — see the module docstring.
	 */
	curated: boolean
	/**
	 * How many source features attested this exact phrase, when the source counts (OSM). `0` for vocabulary sources,
	 * which attest a term's EXISTENCE rather than its frequency.
	 */
	observations: number
}

/**
 * The measured shape of a designator's identifier half — what follows `Gate`/`Terminal` in real data.
 *
 * Derived from OSM `ref` values, not from names. See the module docstring's finding 2.
 */
export interface IdentifierShape {
	designatorID: string
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
}

/**
 * The vocabulary that already ships in `neural/venue-structure.ts`, re-declared. See the module docstring for why this
 * duplication exists and what wave 2 should do about it.
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
 * `wof-osm-placetype-map.mdx`'s own "plausible additions" note, which lists `hall` explicitly. None is
 * `modifierEligible` yet — that claim needs a confound board per term, and this wave produced none.
 */
export const PROPOSED_DESIGNATORS: ReadonlyArray<{
	id: string
	tier: LexiconTier
	provenance: string[]
}> = [
	{ id: "airport", tier: LexiconTier.Venue, provenance: ["osm:aeroway=aerodrome"] },
	{ id: "hall", tier: LexiconTier.SubVenue, provenance: ["wikidata:Q240854"] },
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
		const key = `${phrase} ${recordID} ${lang} ${source}`

		if (seen.has(key)) continue
		seen.add(key)

		out.push({
			phrase,
			recordID,
			recordKind: "designator",
			lang,
			source,
			curated: false,
			observations: 0,
		})
	}

	return out
}

/**
 * One row of `@mailwoman/osm/sdk`'s extractor output, as read back off JSONL. Structurally a subset of
 * `SubVenueSourceRow`; declared locally so the builder does not import `@mailwoman/osm` (which `@mailwoman/corpus` does
 * not depend on) just to name a shape it reads from a file.
 *
 * DELIBERATELY MINIMAL, because OSM is not the only source that fits it. An Overture Places row from the
 * `airport_terminal` category adapts into this shape with a `designatorID` stamped and no `ref` — and it should,
 * because Overture is measurably the better source for one designator: `concourse` appears in 21 Overture rows
 * (`Concourse B`, `South Concourse`, `North Terminal Concourse D`) against 4 in the whole GB OSM extract, of which 3
 * are a street called CONCOURSE WAY. Measured 2026-08-04. See the wave-1 report.
 */
export interface OSMSubVenueRow {
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
 * Whether `name` contains any of `surfaces` as a whole-token run.
 *
 * Token-boundary matching, not substring: `Nordterminal` is a real German compound in which `terminal` is a suffix, and
 * a substring test would also fire on `Terminalstraße`. The compound case is a genuine miss and it is the right miss
 * for wave 1 — admitting suffix matches would fire on every `-hall`/`-gate` compound in Germanic and Nordic street
 * naming, which is exactly the confound class `Briggate`/`Kirkgate` represents.
 */
export function nameContainsSurface(name: string, surfaces: ReadonlySet<string>): string | null {
	const tokens = normalizeSurface(name)
		.split(/[\s,()/]+/u)
		.filter(Boolean)

	for (const token of tokens) {
		const stripped = token.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

		if (stripped && surfaces.has(stripped)) return stripped
	}

	return null
}

/**
 * Harvest attested phrases and identifier shapes out of the OSM extractor's rows.
 *
 * `knownSurfaces` gates the name harvest — a name contributes only when it CONTAINS a designator surface already in the
 * table. That filter is the whole reason this function is safe to run over raw OSM: see the module docstring's finding
 * 1 for the Berlin measurement that motivated it.
 *
 * Returns surfaces with real `observations` counts, so the lexicon can rank `terminal` above a phrase attested once.
 */
export function extractAttestedPhrases(
	rows: Iterable<OSMSubVenueRow>,
	knownSurfaces: ReadonlySet<string>
): { surfaces: SubVenueSurface[]; identifierShapes: IdentifierShape[] } {
	/**
	 * `phrase\0recordID\0lang\0source` → count.
	 */
	const surfaceCounts = new Map<string, number>()
	/**
	 * `designatorID\0shape` → { count, examples }.
	 */
	const shapes = new Map<string, { count: number; examples: Set<string> }>()

	const note = (phrase: string, recordID: string, lang: string, source: string): void => {
		const key = `${phrase} ${recordID} ${lang} ${source}`
		surfaceCounts.set(key, (surfaceCounts.get(key) ?? 0) + 1)
	}

	for (const row of rows) {
		if (row.name) {
			const hit = nameContainsSurface(row.name, knownSurfaces)

			if (hit) {
				note(hit, row.designatorID, "und", "osm:name")
			}
		}

		for (const [lang, localized] of Object.entries(row.localizedNames ?? {})) {
			const hit = nameContainsSurface(localized, knownSurfaces)

			if (hit) {
				note(hit, row.designatorID, lang, `osm:name:${lang}`)
			}
		}

		if (row.ref) {
			const shape = classifyIdentifier(row.ref)
			const key = `${row.designatorID} ${shape}`
			const entry = shapes.get(key) ?? { count: 0, examples: new Set<string>() }

			entry.count++

			if (entry.examples.size < IDENTIFIER_EXAMPLES_PER_SHAPE) {
				entry.examples.add(row.ref.trim())
			}

			shapes.set(key, entry)
		}
	}

	const surfaces: SubVenueSurface[] = [...surfaceCounts].map(([key, observations]) => {
		const [phrase, recordID, lang, source] = key.split(" ") as [string, string, string, string]

		return { phrase, recordID, recordKind: "designator", lang, source, curated: false, observations }
	})

	const identifierShapes: IdentifierShape[] = [...shapes].map(([key, entry]) => {
		const [designatorID, shape] = key.split(" ") as [string, string]

		return {
			designatorID,
			shape,
			observations: entry.count,
			examples: [...entry.examples].toSorted((a, b) => a.localeCompare(b)),
		}
	})

	return { surfaces, identifierShapes }
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
	 * Rows from an `@mailwoman/osm/sdk` extract, or an empty array.
	 */
	osmRows: readonly OSMSubVenueRow[]
	/**
	 * Provenance rows, copied off the fetch manifests by the caller.
	 */
	sources: readonly SubVenueLexiconSource[]
}

/**
 * Build the lexicon table. PURE and deterministic — same inputs, byte-identical output.
 *
 * Order of operations matters in one place: the seed's English surfaces are inserted BEFORE the OSM harvest runs,
 * because `extractAttestedPhrases` gates on the surface set built so far. Wikidata surfaces are added to that gate too,
 * so `Terminal E (Untere Ebene)` is recognized through the English `terminal` and `Nordterminal` is (correctly, per
 * that function's docstring) not recognized at all.
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
				source: "seed",
				// The English designator IS the shipped vocabulary — curated by construction.
				curated: d.shipped,
				observations: 0,
			})
		),
		...modifiers.map(
			(m): SubVenueSurface => ({
				phrase: m.id,
				recordID: m.id,
				recordKind: "modifier",
				lang: "en",
				source: "seed",
				curated: true,
				observations: 0,
			})
		),
	]

	if (input.wikidata) {
		surfaces.push(...surfacesFromWikidata(input.wikidata))
	}

	const knownSurfaces = new Set(surfaces.map((s) => s.phrase))
	const attested = extractAttestedPhrases(input.osmRows, knownSurfaces)
	surfaces.push(...attested.surfaces)

	// Deterministic order everywhere. `localeCompare` matches the tie-break discipline
	// `generate-taxonomy.ts` and `build-brands.ts` already use.
	designators.sort((a, b) => a.id.localeCompare(b.id))
	modifiers.sort((a, b) => a.id.localeCompare(b.id))

	surfaces.sort(
		(a, b) =>
			a.phrase.localeCompare(b.phrase) ||
			a.recordID.localeCompare(b.recordID) ||
			a.lang.localeCompare(b.lang) ||
			a.source.localeCompare(b.source)
	)

	return {
		version: SUBVENUE_LEXICON_VERSION,
		sources: input.sources.toSorted((a, b) => a.id.localeCompare(b.id)),
		designators,
		modifiers,
		surfaces,
		identifierShapes: attested.identifierShapes.toSorted(
			(a, b) => a.designatorID.localeCompare(b.designatorID) || a.shape.localeCompare(b.shape)
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
 * Read a JSONL file of {@link OSMSubVenueRow}s. Blank lines and unparseable rows are skipped rather than fatal — an
 * extract is a build output, and one malformed line should not cost the whole lexicon.
 */
export function readOSMSubVenueJSONL(path: string): OSMSubVenueRow[] {
	const out: OSMSubVenueRow[] = []

	// `TextSpliterator` rather than `split("\n")` — a whole-country extract runs to 250,000 lines
	// (52 MB for Great Britain), and materializing every segment before reading the first is exactly
	// what the repo lint rule exists to prevent.
	for (const line of TextSpliterator.from(readFileSync(path, "utf8"))) {
		const trimmed = line.trim()

		if (!trimmed) continue

		try {
			out.push(parseJSONStrict<OSMSubVenueRow>(trimmed))
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

export interface GenerateSubVenueLexiconOptions {
	/**
	 * Directory holding the `mailwoman corpus fetch wikidata-subvenue` output. Omit to build the seed-only table.
	 */
	wikidataDir?: string
	/**
	 * JSONL of `@mailwoman/osm/sdk` extractor rows. Omit to skip the attested-phrase harvest.
	 */
	osmJSONL?: string
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

	const osmRows = options.osmJSONL ? readOSMSubVenueJSONL(options.osmJSONL) : []

	if (options.osmJSONL) {
		sources.push({
			id: "osm",
			// The extract's NAME, never its path. `AGENTS.md` forbids re-hardcoding the lab data root
			// anywhere, and a committed artifact carrying `/mnt/playpen/...` would do exactly that while
			// telling a reader on another machine nothing. `great-britain` identifies the Geofabrik region,
			// which is the fact that matters.
			origin: `OpenStreetMap via Geofabrik (${basename(options.osmJSONL, ".jsonl")})`,
			license: "ODbL (OpenStreetMap)",
			// The extract's mtime — when the rows were produced. `corpus/AGENTS.md`'s standing warning that
			// a file's mtime is not its DATA's vintage applies to a downloaded archive; this file is a build
			// output of ours, so its mtime is exactly the right number.
			retrieved: statSync(options.osmJSONL).mtime.toISOString().slice(0, 10),
			rows: osmRows.length,
		})
	}

	const table = buildSubVenueLexicon({ wikidata, osmRows, sources })
	writeFileSync(options.outPath, serializeSubVenueLexicon(table))

	return table
}
