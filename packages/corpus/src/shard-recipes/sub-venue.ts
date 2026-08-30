/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `sub-venue` shard recipe (#35 step 4) — teach the `unit` tag the venue-INTERIOR shapes it was
 *   never taught, so the modifier+designator class wins at the shipped `venueStructureBiasScale` of
 *   6.0 instead of needing ~11 nats. `docs/engineering/sub-venue-corpus-task.mdx` is the spec; the
 *   vocabulary is `corpus/data/sub-venue-lexicon.json` (v0.2.0) and the curation ledger is
 *   `corpus/src/tools/sub-venue-promotions.ts`. The READ half — promotions, identifier
 *   distributions, name pools — is `sub-venue-sources.ts`; this file renders lines and emits rows.
 *
 *   ── WHY THIS SYNTHESIZES RATHER THAN HARVESTS ────────────────────────────────────────────────────
 *   Wave 1's lesson, and the reason the spec's "get real data first" instruction is honoured in a
 *   shape it did not anticipate: the attested SURFACE STRINGS are thin. 87 GB features attest
 *   `terminal`, 29 attest `wing`, 4 attest `concourse` (3 of which are a street called CONCOURSE WAY).
 *   You cannot train a tag on 29 strings. What the five extracts DO carry at volume is the three
 *   things a generator needs — 45,000+ real venue names across four countries, a per-region
 *   identifier DISTRIBUTION measured over 2,868 gate/terminal/campus refs, and the confound
 *   population that becomes the negatives. So the bulk is `designator × per-region-identifier ×
 *   modifier` sampled per locale, and the attested strings ride along as seasoning
 *   ({@link ATTESTED_FRACTION}) rather than as the corpus.
 *
 *   ── THE PER-REGION IDENTIFIER RULE, AND WHY IT IS NOT COSMETIC ───────────────────────────────────
 *   `Gate A12` is a rendering, not a string anyone wrote down: all but 13 of Great Britain's 658
 *   `aeroway=gate` features are unnamed and carry only a `ref`. The lexicon therefore ships a
 *   distribution, and it differs by country far more than the shared English vocabulary suggests —
 *   GB gates are 71% bare digits and JP 89%, FR and DE are ~60% letter-digit (`A37`, `B05`), and ES
 *   gives a THIRD of its gates a range (`B18-B20`), which no other country does at that rate. A
 *   generator that samples Great Britain's shape into a Spanish line produces a plausible string that
 *   is wrong about Spain, so every leg samples its own region.
 *
 *   ── ONLY PROMOTED (designator, locale) PAIRS PRODUCE POSITIVES ───────────────────────────────────
 *   A promotion names a designator, a phrase AND a locale, because the same token is a designator in
 *   one language and a disaster in another: `hall` is 0-of-3,273 in Great Britain and 35-of-40 in
 *   France; `wing` is 23-of-29 in Great Britain and 4-of-3,358 in the United States. A REJECTED pair
 *   generates NEGATIVES in that locale instead — en-US `wing` rows are Red Wing, not units.
 *
 *   `shape: "identifier-required"` is honoured as the ledger's docstring demands: de-DE `halle` is
 *   emitted only as `Halle <identifier>`, never bare and never after a modifier, because its 168-hit
 *   confound includes the CITY Halle (Saale) and only the identifier-bearing shape separates them.
 *   {@link buildSubVenueForm} enforces it and `sub-venue.test.ts` pins it.
 *
 *   ── LABELS ───────────────────────────────────────────────────────────────────────────────────────
 *   Sub-venue is `unit`; the container is `venue`. That is the spec's wording and it invents nothing:
 *   `block` / `sub_block` exist in the `ComponentTag` union but are JP-char-model-only and outside
 *   `ACTIVE_TAGS` (STAGE3), so they are not reachable from a Latin shard.
 *
 *   ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────────
 *   1. **A modifier+designator form outside English.** `VENUE_STRUCTURE_MODIFIERS` is an English
 *        list, and the extracts say the localized modifier surfaces do not exist to copy: `aile` in
 *        France is 0 hits, `ala` in Spain 0, `flügel` in Germany 0. Generating `Terminal Sud` would
 *        be inventing a vocabulary with no confound board behind it, which is the exact failure the
 *        promotion ledger exists to prevent. Non-English legs get designator+identifier only.
 *   2. **A ja-JP leg.** `ターミナル` is promoted (1,213 real of 1,215). The one non-Latin
 *        surface the task named, but Japanese addresses train through `build_jp_shard.py` against the
 *        `stage3-jp` 47-label head, where the interior tags are `block`/`sub_block`/`building_number`
 *        — a different model, a different label set, and a different builder. A katakana `unit` row
 *        in this (Latin) feed would in any case be dropped by `country_weights`, which carries no
 *        `JP` key. The JP extract is harvested and ready; the leg belongs to the JP shard.
 */

import { isPresent } from "@mailwoman/core/objects"
import type { ComponentTag } from "@mailwoman/core/types"
import { dataRootPath } from "@mailwoman/core/utils"

import type { LocaleBaseTuple } from "#synthesizers/german"
import type { SubVenueLexiconTable } from "#tools"
import { alignRow } from "#utils"

import { makeMulberry32, shardSourceID, type ShardRecipe } from "./scaffold.ts"
import {
	buildIdentifierModel,
	buildStreetNegatives,
	defaultLexiconPath,
	EMPTY_NAME_POOLS,
	type IdentifierModel,
	loadContextTuples,
	type LegPools,
	mergeNamePools,
	type PoolQuery,
	type PromotedSurface,
	promotedSurfacesFor,
	readExtractPools,
	readPOIPools,
	readSubVenueLexicon,
	rejectedPhrasesFor,
	sampleIdentifier,
	type StreetNegatives,
	titleCase,
} from "./sub-venue-sources.ts"

export * from "./sub-venue-sources.ts"

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals in the register and
   template samplers are weighted-sampler cutoffs, not thresholds: a `const r = random()` followed by
   a cascade of `r < 0.45` branches IS the output distribution, and reading the cascade top-to-bottom
   is how you see it. Genuine thresholds are named constants above. */

//#region Plan

/**
 * One locale's leg of the shard.
 *
 * `positiveShare` / `negativeShare` are relative weights, normalized at run time — they do not have to sum to 1.
 */
export interface SubVenueLeg {
	locale: string
	country: string
	/**
	 * ISO 3166-1 alpha-2 key into the lexicon's `identifierShapes` AND the extract filename. The two axes are the same
	 * axis: a distribution is measured in a region's own extract.
	 */
	region: string
	/**
	 * Extract filename under `--extracts-dir`. Absent = no OSM extract for this leg (en-US), which then draws its venue
	 * and confound pools from `poi.db` instead.
	 */
	extract?: string
	/**
	 * May this leg use the English `<modifier> <designator>` grammar? See the module docstring's exclusion 1.
	 */
	english: boolean
	positiveShare: number
	negativeShare: number
	/**
	 * Ca-ES only — keep context tuples whose postcode starts with one of these. Catalan-language territories by postal
	 * prefix (07 Illes Balears, 08 Barcelona, 17 Girona, 25 Lleida, 43 Tarragona) rather than by a REGION string, whose
	 * spelling in the OA export is not something to guess at.
	 */
	postcodePrefixes?: readonly string[]
}

/**
 * The legs, and the numbers behind the shares.
 *
 * En-GB and en-US carry the most because they are where the eval board lives (28 of the 30 confound rows are GB or US
 * addresses) and because the English shipped vocabulary is the only one with a modifier grammar — the target class.
 * fr-FR, de-DE and es-ES exist because the ledger promoted surfaces there (169, 19+32 and 190 real hits respectively)
 * and a shard that skipped them would leave every non-English promotion untrained. ca-ES is small on purpose: its
 * promotion is 15 hits and its line differs from es-ES only in the Catalan street vocabulary the postal-prefix filter
 * selects for.
 *
 * The negative shares invert that ordering where the confound mass does. en-US carries the largest negative share
 * because its confound population is the largest measured anywhere in the ledger — 3,354 `wing` (Red Wing boots 676,
 * chicken wings 759), 2,330 `pier` (Pier 1 Imports, which IS the designator+identifier shape), 27,081 `hall`.
 */
export const SUBVENUE_LEGS: readonly SubVenueLeg[] = [
	{
		locale: "en-GB",
		country: "GB",
		region: "GB",
		extract: "great-britain.jsonl",
		english: true,
		positiveShare: 0.25,
		negativeShare: 0.3,
	},
	{ locale: "en-US", country: "US", region: "GB", english: true, positiveShare: 0.25, negativeShare: 0.35 },
	{
		locale: "fr-FR",
		country: "FR",
		region: "FR",
		extract: "france.jsonl",
		english: false,
		positiveShare: 0.16,
		negativeShare: 0.2,
	},
	{
		locale: "de-DE",
		country: "DE",
		region: "DE",
		extract: "germany.jsonl",
		english: false,
		positiveShare: 0.14,
		negativeShare: 0.1,
	},
	{
		locale: "es-ES",
		country: "ES",
		region: "ES",
		extract: "spain.jsonl",
		english: false,
		positiveShare: 0.15,
		negativeShare: 0.05,
	},
	{
		locale: "ca-ES",
		country: "ES",
		region: "ES",
		extract: "spain.jsonl",
		english: false,
		positiveShare: 0.05,
		negativeShare: 0,
		postcodePrefixes: ["07", "08", "17", "25", "43"],
	},
]

/**
 * En-US has no OSM extract, so its identifier distribution has to be borrowed. GB is the borrow, and the leg's `region`
 * says so literally rather than in a comment: the two English-speaking aviation systems number their gates the same way
 * (GB 71% bare digit) and poi.db — the only US source in reach — carries names, not refs, so it cannot supply a
 * distribution of its own. Recorded here because it is the one place a leg's `region` is not its own country.
 */
export const US_IDENTIFIER_REGION_BORROWED_FROM = "GB"

//#endregion

//#region Tunables

/**
 * The row count this shard is built at, and the arithmetic behind it. `--count` overrides; this is the number to use
 * absent a reason.
 *
 * The training sampler (`corpus-python/src/mailwoman_train/data_loader.py`, `_raw_row_stream`) draws SOURCES from a
 * multinomial over `source_weights` and yields the next row from that source's iterator. Two consequences set the
 * size:
 *
 * 1. A source's share of an epoch is `weight / Σweights`, independent of how many rows it has.
 * 2. **A source that exhausts is DELETED from the multinomial** — there is no cycling. Under-size the shard and its
 *    nominal dose is fiction for the rest of the epoch.
 *
 * Measured against the shipped `v4.1.0-gb-venue-l1e4-2k` weight table: 33 sources summing to 144.5. At the dose the B11
 * GB-venue exercise settled on for a hard rare class — 12.0, the value `synth-fr-bare-street`, `synth-si-bare-village`,
 * `synth-cz-pcfirst-preposition`, `synth-fr-fragment` and `synth-no-fragment` all carry — the share is `12 / 156.5 =
 * 7.67%`, and `train_rows_per_epoch` is 1,000,000. So the epoch draws **76,677 rows** from this shard, and anything
 * smaller runs dry mid-epoch. 120,000 clears that with room for a config that drops a source or raises the dose. (For
 * contrast: `synth-fr-bare-street` is 10,803 rows at dose 12.0, so it exhausts 14% into its own nominal share every
 * epoch — a precedent for the dose, not for the size.)
 */
export const RECOMMENDED_ROW_COUNT = 120_000

/**
 * Share of emitted rows that are NEGATIVES (the confound classes, carrying no `unit`).
 *
 * The spec's instruction is structural: "include the confound shapes as NEGATIVES in the same shard, or the model
 * learns the surface rather than the structure". 0.3 is the dose the `no-fragment` recipe settled on for its own
 * counter-distribution and there is no measurement here that beats it; `--negative-fraction` moves it.
 */
const DEFAULT_NEGATIVE_FRACTION = 0.3

/**
 * Share of POSITIVES whose sub-venue string is a REAL name lifted verbatim out of an extract rather than synthesized —
 * `Terminal 2 D`, `Pier 1`, `Terminal 1 Flugsteig B`. The seasoning, per the module docstring. Kept small because the
 * attested pool is small: after promotion + shape filtering it is 13–47 strings per leg, and a larger share would just
 * repeat them.
 */
const ATTESTED_FRACTION = 0.1

/**
 * Within the SYNTHESIZED positives of an English leg: the split between the two proposal shapes.
 *
 * Modifier-heavy on purpose. Designator+identifier proposes at 0.85 confidence and already wins the decode at the
 * shipped 6.0; modifier+designator proposes at 0.6 and needs 5.87–10.65. The failing class is the one to teach, and the
 * passing one is here to not regress (`Concourse B` / `Terminal 5` / `Gate 12` / `Wing B` must stay correct).
 */
const ENGLISH_MODIFIER_FORM_FRACTION = 0.6

//#endregion

//#region Board reservation

/**
 * Surfaces reserved by `mailwoman/eval-harness/fixtures/venue-structure-confounds.jsonl` — the 30-row board this shard
 * has to hold. A row containing any of these is DROPPED and counted in `contaminated`.
 *
 * The `--exclude-surfaces` precedent from `fr-fragment` / `no-fragment`, applied by hand rather than by file because
 * the board lives in `mailwoman/` and `@mailwoman/corpus` cannot reach across that workspace boundary at run time. Keep
 * it in sync when the board grows; a shard that trains on its own eval set measures memorization.
 *
 * Note what this costs and why it is still right: reserving `east gate` / `west gate` removes the two GB surfaces the
 * board uses for its `modifier-designator-street` class, so the shard teaches that class from the OTHER real ones its
 * sources carry (`North Gate`, `South Gate`, `East Hall`, `West Hall`, `Lower Hall`, `East Campus`, …). The class is
 * taught; the board's own strings are not.
 */
export const BOARD_RESERVED_SURFACES: readonly string[] = [
	// gb-street-gate
	"briggate",
	"kirkgate",
	"castlegate",
	"micklegate",
	"fishergate",
	"gallowgate",
	"cowgate",
	"canongate",
	"westgate",
	"northgate",
	// gate-house-venue
	"gate house",
	"gatehouse",
	// terminal-estate
	"terminal industrial estate",
	"terminal house",
	"ocean terminal",
	"terminal warehouse",
	// wing-name
	"wing yip",
	"wing lee",
	"bletchley park",
	// designator-as-street
	"campus drive",
	"arcade avenue",
	"concourse village",
	"building society place",
	"enclosure road",
	// modifier-designator-street
	"east gate",
	"west gate",
	"west wickham",
]

/**
 * Does this row's text collide with a board-reserved surface?
 */
export function isBoardReserved(raw: string): boolean {
	const low = raw.toLowerCase()

	return BOARD_RESERVED_SURFACES.some((surface) => low.includes(surface))
}

//#endregion

//#region Rendering

/**
 * One labelled piece of the line. Pieces inside a group are space-joined; groups are joined by the register's
 * separator.
 */
interface Piece {
	text: string
	tag?: ComponentTag
}

type Group = Piece[]

/**
 * Surface register. Every eval in this repo gets a lowercase leg because lowercase is the register users type — Google
 * Maps taught them — so every shard has to carry one.
 */
const Register = {
	Canonical: "canonical",
	CommaFree: "comma-free",
	Lower: "lower",
	Upper: "upper",
} as const

type Register = (typeof Register)[keyof typeof Register]

function sampleRegister(random: () => number): Register {
	const r = random()

	if (r < 0.45) return Register.Canonical

	if (r < 0.65) return Register.CommaFree

	if (r < 0.9) return Register.Lower

	return Register.Upper
}

/**
 * Join groups into `raw` + `components`, applying the register to BOTH so alignment still finds every value.
 */
export function renderGroups(
	groups: Group[],
	register: Register
): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const fold = (text: string): string => {
		if (register === Register.Lower) return text.toLowerCase()

		if (register === Register.Upper) return text.toUpperCase()

		return text
	}

	const separator = register === Register.CommaFree ? " " : ", "

	const raw = groups
		.map((group) => group.map((piece) => fold(piece.text)).join(" "))
		.filter(isPresent)
		.join(separator)

	const components: Partial<Record<ComponentTag, string>> = {}

	for (const group of groups) {
		for (const piece of group) {
			if (piece.tag && !components[piece.tag]) {
				components[piece.tag] = fold(piece.text)
			}
		}
	}

	return { raw, components }
}

/**
 * The street + tail groups for a country, in that country's own order.
 *
 * DE/ES/FR put the postcode before the locality and DE/ES put the house number after the street; GB and US keep the
 * anglophone order and US carries a region. These are the same orders `synthesizers/german.ts` renders, restated here
 * because this recipe assembles its groups piece-by-piece (it has to, to place a sub-venue group in front of them).
 */
export function addressGroups(country: string, tuple: LocaleBaseTuple, withStreet: boolean): Group[] {
	const groups: Group[] = []
	const houseNumber = tuple.house_number?.trim()
	const street = tuple.street.trim()

	if (withStreet && street) {
		const streetPiece: Piece = { text: street, tag: "street" }
		const numberPiece: Piece | null = houseNumber ? { text: houseNumber, tag: "house_number" } : null

		if (!numberPiece) {
			groups.push([streetPiece])
		} else if (country === "DE" || country === "ES") {
			groups.push([streetPiece, numberPiece])
		} else {
			groups.push([numberPiece, streetPiece])
		}
	}

	const locality: Piece = { text: tuple.locality.trim(), tag: "locality" }
	const postcode = tuple.postcode?.trim()
	const region = tuple.region?.trim()

	if (country === "US") {
		groups.push([locality])
		const tail: Group = []

		if (region) {
			tail.push({ text: region, tag: "region" })
		}

		if (postcode) {
			tail.push({ text: postcode, tag: "postcode" })
		}

		if (tail.length) {
			groups.push(tail)
		}
	} else if (country === "GB") {
		groups.push([locality])

		if (postcode) {
			groups.push([{ text: postcode, tag: "postcode" }])
		}
	} else {
		// FR / DE / ES — postcode then locality, one group.
		const tail: Group = []

		if (postcode) {
			tail.push({ text: postcode, tag: "postcode" })
		}

		tail.push(locality)
		groups.push(tail)
	}

	return groups
}

//#endregion

//#region Positive forms

/**
 * A sub-venue string plus how it was made, for the composition report.
 */
export interface SubVenueForm {
	text: string
	form: "designator-identifier" | "modifier-designator" | "attested"
	designatorID: string
}

/**
 * Build one sub-venue string for a leg.
 *
 * The `identifier-required` guard is here and not at the call site on purpose: it is the one rule in this file that a
 * refactor must not be able to route around. A promotion carrying `shape: "identifier-required"` can only ever leave
 * this function as `<Phrase> <identifier>`, and returns `null` rather than a bare or modified form.
 */
export function buildSubVenueForm(
	leg: SubVenueLeg,
	promoted: readonly PromotedSurface[],
	model: IdentifierModel,
	modifiers: readonly string[],
	attested: readonly string[],
	random: () => number
): SubVenueForm | null {
	if (!promoted.length) return null

	if (attested.length && random() < ATTESTED_FRACTION) {
		const text = attested[Math.floor(random() * attested.length)]!

		return { text, form: "attested", designatorID: "attested" }
	}

	const modifierCandidates = leg.english ? promoted.filter((p) => p.modifierEligible && !p.identifierRequired) : []
	const useModifier = modifierCandidates.length > 0 && random() < ENGLISH_MODIFIER_FORM_FRACTION

	if (useModifier) {
		const promotedSurface = modifierCandidates[Math.floor(random() * modifierCandidates.length)]!
		const modifier = modifiers[Math.floor(random() * modifiers.length)]!

		return {
			text: `${titleCase(modifier)} ${promotedSurface.surface}`,
			form: "modifier-designator",
			designatorID: promotedSurface.designatorID,
		}
	}

	const promotedSurface = promoted[Math.floor(random() * promoted.length)]!
	const identifier = sampleIdentifier(model, promotedSurface.designatorID, random)

	if (!identifier) return null

	return {
		text: `${promotedSurface.surface} ${identifier}`,
		form: "designator-identifier",
		designatorID: promotedSurface.designatorID,
	}
}

/**
 * Alias kept for readers of the arc's earlier drafts.
 *
 * @deprecated Use {@link buildSubVenueForm}.
 */
export const buildPositiveForms = buildSubVenueForm

//#endregion

//#region Negatives

/**
 * Negative classes, named so the composition report can count them and a failure can be attributed.
 */
export const NegativeClass = {
	/**
	 * A locale-REJECTED surface in the venue slot: Red Wing Shoes, Village Hall, Porte de Champerret.
	 */
	RejectedVenue: "rejected-venue",
	/**
	 * The designator inside a longer proper name, whole string tagged `venue`: Lochaline Ferry Terminal.
	 */
	LongerName: "longer-name",
	/**
	 * A real street whose name carries a designator token: Pier Road, Egg Hall, Orchard Gate.
	 */
	DesignatorStreet: "designator-street",
	/**
	 * A real street of the `<modifier> <designator>` shape — the class that would otherwise be read as a sub-venue.
	 */
	ModifierDesignatorStreet: "modifier-designator-street",
	/**
	 * A GB single-token `-gate` street: Eastgate, Southgate, Moorgate, Stonegate.
	 */
	GateSuffixStreet: "gate-suffix-street",
	/**
	 * A PROMOTED phrase outside the shape its promotion covers — `Halle Rosengarten`, `PHOENIX Halle`. The other half of
	 * an `identifier-required` ruling; see `LegPools.unpromotedShapes`.
	 */
	UnpromotedShape: "unpromoted-shape",
} as const

export type NegativeClass = (typeof NegativeClass)[keyof typeof NegativeClass]

/**
 * Which negative classes this leg's pools can actually produce. A class with no source is ABSENT rather than
 * substituted — the report then says so, and a reader can tell a missing class from an unsampled one.
 */
function availableNegativeClasses(pools: LegPools, streets: StreetNegatives): NegativeClass[] {
	const available: NegativeClass[] = []

	const sourced: ReadonlyArray<readonly [NegativeClass, number]> = [
		[NegativeClass.RejectedVenue, pools.rejectedVenues.length],
		[NegativeClass.LongerName, pools.longerNames.length],
		[NegativeClass.UnpromotedShape, pools.unpromotedShapes.length],
		[NegativeClass.DesignatorStreet, streets.designator.length],
		[NegativeClass.ModifierDesignatorStreet, streets.modifierDesignator.length],
		[NegativeClass.GateSuffixStreet, streets.gateSuffix.length],
	]

	for (const [negativeClass, size] of sourced) {
		if (size > 0) {
			available.push(negativeClass)
		}
	}

	return available
}

//#endregion

//#region Recipe

/**
 * Per-leg composition tallies the build prints and the report quotes.
 */
export interface SubVenueLegStats {
	locale: string
	positives: number
	negatives: number
	byForm: Record<string, number>
	byDesignator: Record<string, number>
	byNegativeClass: Record<string, number>
	byRegister: Record<string, number>
	poolSizes: Record<string, number>
}

const LICENSE =
	"Synthetic — OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) and Overture Places names " +
	"(CDLA-Permissive-2.0) over OpenAddresses / HM Land Registry Price Paid Data address skeletons"

const CORPUS_VERSION = "0.16.0"

const bump = (record: Record<string, number>, key: string): void => {
	record[key] = (record[key] ?? 0) + 1
}

/**
 * Everything the emit loop needs that does not vary per row.
 */
interface EmitContext {
	write: (line: string) => void
	source: string
	random: () => number
	modifiers: readonly string[]
	designatorPhrases: readonly string[]
	counters: { emitted: number; skipped: number; contaminated: number }
}

/**
 * Render one row, drop it if it collides with the eval board, align it, write it.
 *
 * A free function rather than a closure over the leg loop: a closure there is both a lint error (`no-loop-func`) and a
 * real hazard, since it would capture the loop's mutable counters.
 */
function emitRow(
	context: EmitContext,
	leg: SubVenueLeg,
	stats: SubVenueLegStats,
	groups: Group[],
	register: Register,
	synthMethod: string,
	disambiguator: Record<string, string>
): boolean {
	const { raw, components } = renderGroups(groups, register)

	if (isBoardReserved(raw)) {
		context.counters.contaminated++

		return false
	}

	const aligned = alignRow({
		raw,
		components,
		country: leg.country,
		locale: leg.locale,
		source: context.source,
		source_id: shardSourceID(context.source, { ...components, ...disambiguator }),
		corpus_version: CORPUS_VERSION,
		license: LICENSE,
	})

	if (aligned.kind !== "labeled" || !aligned.row) {
		context.counters.skipped++

		return false
	}

	context.write(JSON.stringify({ ...aligned.row, synth_method: synthMethod, synth_base_id: null }) + "\n")

	context.counters.emitted++
	bump(stats.byRegister, register)

	return true
}

/**
 * Emit one leg's POSITIVE rows: `<sub-venue> unit`, a real `venue`, and the leg's own address skeleton.
 */
function emitPositives(
	context: EmitContext,
	leg: SubVenueLeg,
	pools: LegPools,
	promoted: readonly PromotedSurface[],
	model: IdentifierModel,
	stats: SubVenueLegStats,
	target: number
): void {
	const { random } = context
	let produced = 0
	let guard = 0

	while (produced < target && guard++ < target * 8) {
		if (!pools.context.length || !pools.venues.length) break
		const form = buildSubVenueForm(leg, promoted, model, context.modifiers, pools.attested, random)

		if (!form) {
			context.counters.skipped++

			continue
		}

		const tuple = pools.context[Math.floor(random() * pools.context.length)]!
		const venue = pools.venues[Math.floor(random() * pools.venues.length)]!

		// A venue name that CONTAINS the sub-venue string (or vice versa) makes the two spans
		// unresolvable — alignment claims the longer one and quarantines the other — and the row would
		// teach an overlap that never occurs on a real envelope. Redraw instead.
		const lowVenue = venue.toLowerCase()
		const lowForm = form.text.toLowerCase()

		if (lowVenue.includes(lowForm) || lowForm.includes(lowVenue)) continue

		const register = sampleRegister(random)
		const subGroup: Group = [{ text: form.text, tag: "unit" }]
		const venueGroup: Group = [{ text: venue, tag: "venue" }]
		const r = random()
		// A quarter of rows carry no street: an airport terminal's address usually does not have one.
		const body = addressGroups(leg.country, tuple, r >= 0.25)
		// Both orders occur on real signage and mail — "Terminal 5, Heathrow" and "Heathrow, Terminal 5".
		const groups = r < 0.55 ? [subGroup, venueGroup, ...body] : [venueGroup, subGroup, ...body]

		const ok = emitRow(context, leg, stats, groups, register, `sub-venue:${form.form}`, {
			leg: leg.locale,
			form: form.form,
			v: String(produced),
		})

		if (!ok) continue

		produced++

		stats.positives++
		bump(stats.byForm, form.form)
		bump(stats.byDesignator, form.designatorID)
	}
}

/**
 * Emit one leg's NEGATIVE rows — the confound classes, none of which carries a `unit`.
 */
function emitNegatives(
	context: EmitContext,
	leg: SubVenueLeg,
	pools: LegPools,
	stats: SubVenueLegStats,
	target: number
): void {
	const { random } = context
	const streets = buildStreetNegatives(pools.context, context.designatorPhrases, context.modifiers, leg.country)
	const available = availableNegativeClasses(pools, streets)
	let produced = 0
	let guard = 0

	while (produced < target && guard++ < target * 8) {
		if (!available.length || !pools.context.length) break
		const negativeClass = available[Math.floor(random() * available.length)]!
		const register = sampleRegister(random)
		let groups: Group[]

		if (negativeClass === NegativeClass.DesignatorStreet) {
			groups = addressGroups(leg.country, pickTuple(streets.designator, random), true)
		} else if (negativeClass === NegativeClass.ModifierDesignatorStreet) {
			groups = addressGroups(leg.country, pickTuple(streets.modifierDesignator, random), true)
		} else if (negativeClass === NegativeClass.GateSuffixStreet) {
			groups = addressGroups(leg.country, pickTuple(streets.gateSuffix, random), true)
		} else {
			const pool =
				negativeClass === NegativeClass.RejectedVenue
					? pools.rejectedVenues
					: negativeClass === NegativeClass.LongerName
						? pools.longerNames
						: pools.unpromotedShapes

			const name = pool[Math.floor(random() * pool.length)]!
			const tuple = pools.context[Math.floor(random() * pools.context.length)]!

			groups = [[{ text: name, tag: "venue" }], ...addressGroups(leg.country, tuple, random() < 0.75)]
		}

		const ok = emitRow(context, leg, stats, groups, register, `sub-venue-negative:${negativeClass}`, {
			leg: leg.locale,
			negative: negativeClass,
			v: String(produced),
		})

		if (!ok) continue

		produced++

		stats.negatives++
		bump(stats.byNegativeClass, negativeClass)
	}
}

function pickTuple(pool: readonly LocaleBaseTuple[], random: () => number): LocaleBaseTuple {
	return pool[Math.floor(random() * pool.length)]!
}

/**
 * Split `total` across `shares` (which need not sum to 1), largest-remainder so the parts sum exactly.
 */
export function allocate(total: number, shares: readonly number[]): number[] {
	const sum = shares.reduce((a, b) => a + b, 0)

	if (sum <= 0) return shares.map(() => 0)
	const exact = shares.map((s) => (total * s) / sum)
	const floored = exact.map((v) => Math.floor(v))
	let remainder = total - floored.reduce((a, b) => a + b, 0)
	const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).toSorted((a, b) => b.frac - a.frac)

	for (const entry of order) {
		if (remainder <= 0) break
		floored[entry.i]! += 1

		remainder--
	}

	return floored
}

/**
 * Build one leg's pools: the name pools from its extract and/or poi.db, plus its address context.
 */
async function buildLegPools(
	leg: SubVenueLeg,
	query: PoolQuery,
	contextByCountry: ReadonlyMap<string, LocaleBaseTuple[]>,
	paths: { extractsDir: string; poiDB: string }
): Promise<LegPools> {
	const extractPools = leg.extract
		? await readExtractPools(`${paths.extractsDir}/${leg.extract}`, query)
		: EMPTY_NAME_POOLS

	// poi.db holds four countries; only these two legs are inside it.
	const poiPools =
		leg.country === "US" || leg.country === "FR" ? readPOIPools(paths.poiDB, leg.country, query) : EMPTY_NAME_POOLS

	const names = mergeNamePools(extractPools, poiPools)
	let context = contextByCountry.get(leg.country) ?? []

	if (leg.postcodePrefixes) {
		const prefixes = leg.postcodePrefixes
		const filtered = context.filter((t) => prefixes.some((p) => (t.postcode ?? "").startsWith(p)))

		// A leg that filters itself empty is a build-time fact worth failing on, not a silent fallback
		// to the parent locale's rows under a different `locale` stamp.
		if (!filtered.length) {
			throw new Error(
				`${leg.locale}: no context tuples matched postcode prefixes ${prefixes.join(",")} among ${context.length} ${leg.country} rows`
			)
		}

		context = filtered
	}

	return { context, ...names }
}

function emptyStats(leg: SubVenueLeg, pools: LegPools, promotedCount: number): SubVenueLegStats {
	return {
		locale: leg.locale,
		positives: 0,
		negatives: 0,
		byForm: {},
		byDesignator: {},
		byNegativeClass: {},
		byRegister: {},
		poolSizes: {
			promoted: promotedCount,
			context: pools.context.length,
			venues: pools.venues.length,
			attested: pools.attested.length,
			rejectedVenues: pools.rejectedVenues.length,
			longerNames: pools.longerNames.length,
			unpromotedShapes: pools.unpromotedShapes.length,
		},
	}
}

/**
 * Shard recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const subVenueRecipe: ShardRecipe = {
	name: "sub-venue",
	description:
		"Venue-interior structure (#35): <sub-venue> unit + <venue> lines per promoted (designator, locale) pair, with the rejection ledger's confounds as negatives",
	mode: "generate",
	options: [
		{ flag: "--lexicon <path>", description: "sub-venue lexicon JSON (default: the committed corpus/data one)" },
		{
			flag: "--extracts-dir <dir>",
			description: "OSM sub-venue extract JSONLs (default: $MAILWOMAN_DATA_ROOT/sub-venue/extracts)",
		},
		{
			flag: "--poi-db <path>",
			description: "poi.db for the en-US / fr-FR pools (default: $MAILWOMAN_DATA_ROOT/poi/poi.db)",
		},
		{ flag: "--sub-venue-tuples <path>", description: "GB/US/FR address-context tuples JSONL" },
		{
			flag: "--negative-fraction <n>",
			description: `share of rows that are confound negatives (default ${DEFAULT_NEGATIVE_FRACTION})`,
		},
	],
	async run(opts, write) {
		if (opts.count == null) throw new Error("sub-venue recipe requires --count <N>")
		const count = opts.count
		const negativeFraction = opts.negativeFraction ?? DEFAULT_NEGATIVE_FRACTION
		const extractsDir = opts.extractsDir ?? dataRootPath("sub-venue", "extracts")
		const poiDB = opts.poiDB ?? dataRootPath("poi", "poi.db")
		const tuplesPath = opts.subVenueTuples ?? dataRootPath("corpus", "intermediate", "house-venue-tuples-v3.jsonl")
		const lexicon: SubVenueLexiconTable = await readSubVenueLexicon(opts.lexicon ?? defaultLexiconPath())

		const context: EmitContext = {
			write,
			source: opts.sourceName ?? "synth-sub-venue",
			random: makeMulberry32(opts.seed),
			modifiers: lexicon.modifiers.filter((m) => m.shipped).map((m) => m.id),
			designatorPhrases: lexicon.designators.filter((d) => d.tier === "subvenue").map((d) => d.id),
			counters: { emitted: 0, skipped: 0, contaminated: 0 },
		}

		console.error(`  reading context tuples: ${tuplesPath}`)

		const contextByCountry = await loadContextTuples(tuplesPath, opts.seed)
		const legPools = new Map<string, LegPools>()
		const legStats = new Map<string, SubVenueLegStats>()
		const legPromoted = new Map<string, PromotedSurface[]>()

		for (const leg of SUBVENUE_LEGS) {
			const promoted = promotedSurfacesFor(leg.locale, lexicon)

			const query: PoolQuery = {
				promoted,
				rejectedPhrases: rejectedPhrasesFor(leg.locale),
				designatorPhrases: context.designatorPhrases,
				modifiers: context.modifiers,
				english: leg.english,
			}

			const pools = await buildLegPools(leg, query, contextByCountry, { extractsDir, poiDB })

			legPromoted.set(leg.locale, promoted)
			legPools.set(leg.locale, pools)
			legStats.set(leg.locale, emptyStats(leg, pools, promoted.length))
		}

		const positiveTotal = Math.round(count * (1 - negativeFraction))

		const positiveQuota = allocate(
			positiveTotal,
			SUBVENUE_LEGS.map((l) => l.positiveShare)
		)

		const negativeQuota = allocate(
			count - positiveTotal,
			SUBVENUE_LEGS.map((l) => l.negativeShare)
		)

		for (const [index, leg] of SUBVENUE_LEGS.entries()) {
			const pools = legPools.get(leg.locale)!
			const stats = legStats.get(leg.locale)!
			const promoted = legPromoted.get(leg.locale)!
			const model = buildIdentifierModel(lexicon, leg.region)

			emitPositives(context, leg, pools, promoted, model, stats, positiveQuota[index]!)
			emitNegatives(context, leg, pools, stats, negativeQuota[index]!)
		}

		for (const stats of legStats.values()) {
			console.error(
				`  ${stats.locale}: +${stats.positives} positives / -${stats.negatives} negatives ` +
					`forms=${JSON.stringify(stats.byForm)} designators=${JSON.stringify(stats.byDesignator)} ` +
					`negclasses=${JSON.stringify(stats.byNegativeClass)} registers=${JSON.stringify(stats.byRegister)} ` +
					`pools=${JSON.stringify(stats.poolSizes)}`
			)
		}

		return { read: count, ...context.counters }
	},
}

//#endregion
