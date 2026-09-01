/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The READ half of the `sub-venue` shard recipe (#35 step 4): which surfaces a locale may emit,
 *   what identifier follows them in that region, and which real names become the confound negatives.
 *   `sub-venue.ts` owns the WRITE half (line rendering + the emit loop) and the recipe registration;
 *   split because the two halves together run past the 750-line file cap, and this is the seam — one
 *   side reads disk and the ledger, the other side never touches either.
 *
 *   Every rule in this file is a rule about EVIDENCE, and each one has a measurement behind it:
 *
 *   - {@link promotedSurfacesFor} — a promotion names a designator, a phrase AND a locale, because the
 *       same token is a designator in one language and a disaster in another (`hall` is 0-of-3,273 in
 *       Great Britain and 35-of-40 in France).
 *   - {@link hasPromotedShape} — an `identifier-required` promotion is exercised only as
 *       `<phrase> <identifier>`. The de-DE `halle` board is the founding case: its 168-hit confound
 *       includes the CITY Halle (Saale), and only the identifier-bearing shape separates them.
 *   - {@link buildIdentifierModel} — the identifier distribution is measured per REGION, because it
 *       differs by country far more than the shared vocabulary suggests (GB gates 71% bare digit, ES
 *       35% ranges).
 *   - {@link isVenueSlotName} / {@link isSignIdentifier} — the filters that keep bus-stop codes, route
 *       descriptions and street names out of the slots they would mislabel. Both were written FROM
 *       smoke output, not predicted; the docstrings name the strings that produced them.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { dataRootPath } from "@mailwoman/core/utils"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { readTuples as readLocaleTuples, type LocalePart } from "#shard-recipes/locale"
import { makeMulberry32, readTuples as readShardTuples } from "#shard-recipes/scaffold"
import type { LocaleBaseTuple } from "#synthesizers/german"
import { pick, weightedPick } from "#synthesizers/utils"
import {
	classifyIdentifier,
	readSubVenueJSONL,
	type SubVenueLexiconTable,
	SUBVENUE_PROMOTIONS,
	type SubVenuePromotion,
} from "#tools"

//#region Lexicon

/**
 * The committed lexicon, resolved through the package manifest.
 */
export function defaultLexiconPath(): string {
	return resolveModulePath("@mailwoman/corpus/data/sub-venue-lexicon.json")
}

/**
 * Read and parse the lexicon. Strict: a corrupt lexicon is a build failure, not a fallback.
 */
export async function readSubVenueLexicon(path: string = defaultLexiconPath()): Promise<SubVenueLexiconTable> {
	return await readLocalJSONFile<SubVenueLexiconTable>(path)
}

//#endregion

//#region Name filters

/**
 * Longest venue name kept for the venue slot. The extracts carry a tail of route descriptions and junction names
 * ("Furnival Gate/Moorhead MH2", "SPEKE HALL ROAD/HILLFOOT AVE") that are not venue names at all; a length cap plus
 * {@link isCleanName} removes the bulk of them without a hand list.
 */
const MAX_VENUE_NAME_LENGTH = 44

/**
 * Shortest kept name. Below four characters a "name" is an airport code or a platform letter, not something that can
 * stand in a venue slot.
 */
const MIN_NAME_LENGTH = 4

/**
 * Longest attested sub-venue string, in whitespace tokens. `Terminal 1 Flugsteig B` is four and real; anything longer
 * is a venue's own name that happens to contain a designator.
 */
const MAX_ATTESTED_TOKENS = 4

/**
 * Reject a name that is a route description, a junction, or a code rather than a name: embedded `/`, `;`, `,`, `:`,
 * parentheses, no letters, or a bare source code. Measured motivation, not taste — the GB extract's `platform` tier
 * contributes 7,549 `other`-shaped names like `kntgwdgj` and `SPEKE HALL ROAD/HILLFOOT AVE`.
 */
export function isCleanName(name: string): boolean {
	if (name.length < MIN_NAME_LENGTH || name.length > MAX_VENUE_NAME_LENGTH) return false

	// A colon in a name is a qualifier, not part of it — "Porte 4 : Ferrys", "Derby College: Ilkeston Campus".
	if (/[/;,:()[\]<>|]/.test(name)) return false

	if (!/\p{L}/u.test(name)) return false

	// A name that is all lower-case with no space is a source code (`kntgwdgj`), not a name.
	if (!name.includes(" ") && name === name.toLowerCase()) return false

	return true
}

/**
 * Head words that make a "name" something other than a venue name, checked on the FIRST token.
 *
 * Two populations, both found by reading the 2026-08-05 smoke output rather than predicted:
 *
 * - **Street types.** A bus stop is routinely named after the street it stands on, so the FR extract offers `Rue de la
 *   Porte Bergault` as a `porte` confound. It IS a confound, but it is a STREET, and putting it in the venue slot would
 *   train `Rue …` as a venue name — trading one mislabel for another.
 * - **Stop qualifiers.** British stop names carry a position prefix (`OPPOSITE BRICKLEHAMPTON HALL`, `ADJ THE GREEN`)
 *   that names a relationship rather than a place.
 *
 * Per-language and short on purpose: this is a head-token filter over four Latin languages, not a street-type
 * gazetteer. `@mailwoman/corpus` cannot reach the shipped street-type lexicon (it lives behind the gazetteer build),
 * and a longer list here would be a second, drifting copy of it.
 */
const NON_VENUE_HEAD_WORDS: ReadonlySet<string> = new Set([
	// en
	"street",
	"road",
	"lane",
	"avenue",
	"drive",
	"way",
	"close",
	"opposite",
	"opp",
	"adj",
	"adjacent",
	"outside",
	"near",
	"nr",
	"stop",
	// fr
	"rue",
	"boulevard",
	"chemin",
	"impasse",
	"allée",
	"allee",
	"route",
	"quai",
	"place",
	// es / ca
	"calle",
	"carrer",
	"avenida",
	"avinguda",
	"carretera",
	"plaza",
	"paseo",
	"camino",
	// de
	"straße",
	"strasse",
	"weg",
	"platz",
	"gasse",
])

/**
 * Street types that appear at the END of an anglophone street name, checked on the LAST token.
 *
 * The head-word filter cannot see these — English streets are `<name> <type>`, so `Strawberry Hall Lane` and `Guinea
 * Hall Mews` reached the venue slot in the second smoke and would have trained a STREET as a venue name. The
 * street-side confound already has its own class (`designator-street`), drawn from real (street, locality, postcode)
 * pairings, so nothing is lost by refusing these here. German is suffix-compounded rather than suffix-worded and is
 * handled by {@link GERMAN_STREET_TAIL} instead.
 */
const STREET_TAIL_WORDS: ReadonlySet<string> = new Set([
	"street",
	"road",
	"lane",
	"avenue",
	"drive",
	"close",
	"crescent",
	"mews",
	"terrace",
	"walk",
	"way",
	"court",
	"gardens",
	"grove",
	"rise",
	"row",
	"parade",
	"esplanade",
])

const GERMAN_STREET_TAIL = /(?:straße|strasse|weg|platz|gasse|allee|ring|damm)$/

/**
 * Is this name usable as a VENUE-slot string (positive venue or negative confound venue)?
 */
export function isVenueSlotName(name: string): boolean {
	if (!isCleanName(name)) return false
	const words = name.toLowerCase().match(/[\p{L}]+/gu) ?? []

	if (!words.length) return false

	if (NON_VENUE_HEAD_WORDS.has(words[0]!)) return false
	const tail = words.at(-1)!

	return !STREET_TAIL_WORDS.has(tail) && !GERMAN_STREET_TAIL.test(tail)
}

//#endregion

//#region Promotions

/**
 * A (designator, surface) pair usable in one locale, with the shape constraint the ledger attached to it.
 */
export interface PromotedSurface {
	designatorID: string
	phrase: string
	/**
	 * Rendering form — the phrase title-cased, which is how a sign writes it.
	 */
	surface: string
	identifierRequired: boolean
	modifierEligible: boolean
}

/**
 * Title-case a designator phrase for rendering (`flugsteig` → `Flugsteig`). Single-token by construction: every
 * promoted phrase in the ledger is one word.
 */
export function titleCase(phrase: string): string {
	return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * Word-boundary containment, script-aware enough for the Latin legs this recipe runs.
 *
 * The boundary matters: without it `gate` matches Briggate and `wing` matches Wingate, which is how a harvest teaches
 * itself that a Yorkshire street is a sub-venue. (The lexicon's own harvest carries the same rule, and it drops the
 * boundary only for Han/Kana, which has no word boundaries and no leg here.)
 */
export function containsPhrase(lowerName: string, phrase: string): boolean {
	let from = 0

	for (;;) {
		const at = lowerName.indexOf(phrase, from)

		if (at === -1) return false
		const before = at === 0 ? "" : lowerName[at - 1]!
		const after = lowerName[at + phrase.length] ?? ""

		if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true
		from = at + 1
	}
}

/**
 * Identifier-shape classes a sub-venue string may sample.
 *
 * `other` is excluded: it is the junk bucket the lexicon's own examples advertise — `C15/C15A+C15B`, `Segelflug Start
 * 06`, `152, 240`, `de.05374048.drabenderhoehezeithstrasse`. Everything else is a real identifier register.
 */
const USABLE_IDENTIFIER_SHAPES: ReadonlySet<string> = new Set([
	"digit",
	"letter",
	"letter-digit",
	"digit-letter",
	"range",
])

/**
 * One atom of a sign identifier: a short number (`5`, `205`), a single letter (`B`), a letter-then-number (`A12`,
 * `B05`), or a number-then-letter (`2F`, `4S`).
 *
 * The **single** leading letter is the required part, and it is what the third smoke found. A letter-digit ref with a
 * MULTI-letter prefix is not an identifier read off a sign, it is a network code: the lexicon's own examples of that
 * shape are `BS04`, `BS07`, `PWP2`, `WSW3687`, `RQ8` — campus and platform codes — and the GB extract offers `Arundel
 * Gate AG1` … `AG124`, fourteen bus stops on a Sheffield STREET called Arundel Gate whose stop codes begin with its
 * initials. Admitting two-letter prefixes put all fourteen in the attested pool as `unit`.
 */
const SIGN_IDENTIFIER_ATOM = /^(?:[0-9]{1,3}|[A-Za-z]|[A-Za-z][0-9]{1,3}|[0-9]{1,3}[A-Za-z]{1,2})$/

/**
 * Is `value` what a sub-venue identifier looks like on a sign — an atom, or a range of two?
 *
 * Applied on top of {@link USABLE_IDENTIFIER_SHAPES}, which classifies but does not bound: `WSW3687` classifies as
 * `letter-digit` and is a station code.
 */
export function isSignIdentifier(value: string): boolean {
	const parts = value.split(/[/-]/)

	if (parts.length > 2 || parts.some((p) => !p)) return false

	return parts.every((part) => SIGN_IDENTIFIER_ATOM.test(part))
}

/**
 * Does a real extract name exercise `promoted` in one of the two shapes this shard teaches?
 *
 * Only `<phrase> <identifier>` and (English legs) `<modifier> <phrase>` qualify. That is stricter than "contains the
 * phrase", and the 2026-08-05 smoke is why: the loose test put `Glasgow Clyde College - Langside Campus`, `Terminal de
 * Ferry de Bilbao` and — worst — `Halle Wohnstadt Nord` into the attested pool, the last of which is a bare German
 * `Halle` wearing a name where the ledger requires an identifier. A whole venue's name is not a sub-venue string, and
 * an attested string that violates the promotion's own shape constraint is not attestation of it.
 *
 * The follower is checked with {@link classifyIdentifier} plus {@link isSignIdentifier} rather than "any following
 * word": `Wohnstadt` is a word, `8` is an identifier, and the de-DE board turns on exactly that difference.
 */
export function hasPromotedShape(
	lowerName: string,
	promoted: PromotedSurface,
	modifiers: readonly string[] = [],
	english = false
): boolean {
	if (!containsPhrase(lowerName, promoted.phrase)) return false

	const escaped = promoted.phrase.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
	const withFollower = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}\\s+(\\S+)`, "u")
	const follower = withFollower.exec(lowerName)?.[1]

	if (follower && USABLE_IDENTIFIER_SHAPES.has(classifyIdentifier(follower)) && isSignIdentifier(follower)) return true

	if (promoted.identifierRequired) return false

	if (!english || !promoted.modifierEligible) return false

	return modifiers.some((modifier) =>
		new RegExp(`(?:^|[^\\p{L}\\p{N}])${modifier}\\s+${escaped}(?![\\p{L}\\p{N}])`, "u").test(lowerName)
	)
}

/**
 * {@link hasPromotedShape} plus the length cap that makes a string usable AS a sub-venue span.
 *
 * The two are separate because the difference decides which POOL a name lands in. `navette n2 vers terminal 2g` carries
 * the promoted shape and is five tokens: too long to be a sub-venue string, and disqualified from being a NEGATIVE
 * precisely because it does contain the shape. It belongs to neither pool, and only splitting the test says so.
 */
export function matchesPromotedShape(
	lowerName: string,
	promoted: PromotedSurface,
	modifiers: readonly string[] = [],
	english = false
): boolean {
	if ((lowerName.match(/\S+/g) ?? []).length > MAX_ATTESTED_TOKENS) return false

	return hasPromotedShape(lowerName, promoted, modifiers, english)
}

/**
 * The surfaces a locale may emit as `unit`.
 *
 * Two inputs, and the difference between them is the advisory/binding split the ledger's docstring names:
 *
 * - The SHIPPED English vocabulary (`neural/venue-structure.ts`, re-declared in the lexicon as `shipped: true`) is a flat
 *   English list with no locale gate. It is promoted-by-shipping for the English legs, because the span proposer fires
 *   on it there today and the eval board's target cases are drawn from it.
 * - {@link SUBVENUE_PROMOTIONS} adds the localized surfaces and SUBTRACTS the rejections. A rejection of a shipped
 *   designator cannot un-ship it (nothing here stops the proposer firing on "Red Wing"), but it absolutely stops this
 *   recipe generating a positive: en-US `wing` produces negatives instead.
 */
export function promotedSurfacesFor(
	locale: string,
	lexicon: SubVenueLexiconTable,
	promotions: readonly SubVenuePromotion[] = SUBVENUE_PROMOTIONS
): PromotedSurface[] {
	const language = locale.split("-")[0]!

	const rejected = new Set(
		promotions.filter((p) => p.decision === "reject" && p.locale === locale).map((p) => `${p.designatorID}|${p.phrase}`)
	)

	const out = new Map<string, PromotedSurface>()

	if (language === "en") {
		for (const designator of lexicon.designators) {
			if (!designator.shipped) continue
			const key = `${designator.id}|${designator.id}`

			if (rejected.has(key)) continue

			out.set(key, {
				designatorID: designator.id,
				phrase: designator.id,
				surface: titleCase(designator.id),
				identifierRequired: false,
				modifierEligible: designator.modifierEligible,
			})
		}
	}

	for (const promotion of promotions) {
		if (promotion.decision !== "promote" || promotion.locale !== locale) continue
		const designator = lexicon.designators.find((d) => d.id === promotion.designatorID)
		const key = `${promotion.designatorID}|${promotion.phrase}`

		if (rejected.has(key)) continue

		out.set(key, {
			designatorID: promotion.designatorID,
			phrase: promotion.phrase,
			surface: titleCase(promotion.phrase),
			identifierRequired: promotion.shape === "identifier-required",
			// A promotion marks a SURFACE usable; it does not widen the modifier grammar (the ledger's
			// own words). Modifier eligibility stays the designator's, and only English legs read it.
			modifierEligible: Boolean(designator?.modifierEligible) && promotion.shape !== "identifier-required",
		})
	}

	return [...out.values()].toSorted((a, b) => a.phrase.localeCompare(b.phrase))
}

/**
 * The phrases REJECTED in a locale — the negatives' vocabulary.
 */
export function rejectedPhrasesFor(
	locale: string,
	promotions: readonly SubVenuePromotion[] = SUBVENUE_PROMOTIONS
): string[] {
	return promotions.filter((p) => p.decision === "reject" && p.locale === locale).map((p) => p.phrase)
}

//#endregion

//#region Identifier sampling

interface ShapeBucket {
	shape: string
	observations: number
	examples: string[]
}

/**
 * A region's identifier distributions: per designator, plus the pooled fallback.
 */
export interface IdentifierModel {
	byDesignator: Map<string, ShapeBucket[]>
	pooled: ShapeBucket[]
}

/**
 * Designators whose refs the pooled fallback is built from.
 *
 * `platform` and `station` are excluded deliberately even though they are by far the largest buckets (GB alone has
 * 25,109 platform digits): a platform ref is a network identifier, and its `other` bucket is 7,549 rows of
 * `kntgwdgj`-style source codes. The three kept here are the ones whose refs are what a person reads off a sign.
 */
const POOLED_IDENTIFIER_DESIGNATORS: readonly string[] = ["gate", "terminal", "campus"]

/**
 * Minimum usable observations before a (region, designator) uses its OWN identifier distribution.
 *
 * Below this the sample is noise — ES `terminal` has 5 usable refs — so the leg falls back to the region's pooled
 * gate+terminal+campus distribution, which is what the lexicon measured at volume (452–655 refs per region). The
 * fallback keeps the axis that matters (the REGION) and drops only the per-designator refinement.
 */
const MIN_OWN_SHAPE_OBSERVATIONS = 20

/**
 * Build the per-region identifier model out of the lexicon's `identifierShapes`.
 */
export function buildIdentifierModel(lexicon: SubVenueLexiconTable, region: string): IdentifierModel {
	const byDesignator = new Map<string, ShapeBucket[]>()
	const pooled: ShapeBucket[] = []

	for (const row of lexicon.identifierShapes) {
		if (row.region !== region) continue

		if (!USABLE_IDENTIFIER_SHAPES.has(row.shape)) continue
		const examples = row.examples.filter((e) => isSignIdentifier(e))

		if (!examples.length) continue
		const bucket: ShapeBucket = { shape: row.shape, observations: row.observations, examples }
		const list = byDesignator.get(row.designatorID)

		if (list) {
			list.push(bucket)
		} else {
			byDesignator.set(row.designatorID, [bucket])
		}

		if (POOLED_IDENTIFIER_DESIGNATORS.includes(row.designatorID)) {
			pooled.push(bucket)
		}
	}

	return { byDesignator, pooled }
}

/**
 * Draw one identifier for `designatorID` in this region.
 *
 * Own distribution when it has {@link MIN_OWN_SHAPE_OBSERVATIONS} usable observations, else the region's pooled one.
 * Shapes are weighted by observation count and an example is drawn uniformly inside the chosen shape — the lexicon
 * ships up to eight per shape, which is the resolution available.
 */
export function sampleIdentifier(model: IdentifierModel, designatorID: string, random: () => number): string | null {
	const own = model.byDesignator.get(designatorID) ?? []
	const ownTotal = own.reduce((sum, b) => sum + b.observations, 0)
	const buckets = ownTotal >= MIN_OWN_SHAPE_OBSERVATIONS ? own : model.pooled

	if (!buckets.length) return null

	// `inclusive: false` keeps this draw's original strict `r < 0` boundary, so the bucket stream is unchanged.
	const bucket = weightedPick(buckets, random, (b) => b.observations, { inclusive: false })

	return pick(bucket.examples, random)
}

//#endregion

//#region Pools

/**
 * Per-leg pools read off disk once.
 */
export interface LegPools {
	context: LocaleBaseTuple[]
	/**
	 * Real venue names for the venue slot (stations, airports, campuses; US: airports, terminals, hospitals, rail).
	 */
	venues: string[]
	/**
	 * Real sub-venue strings, already filtered to this locale's promoted surfaces and their shape constraint.
	 */
	attested: string[]
	/**
	 * Real names carrying a surface REJECTED in this locale, for the venue slot of a negative row.
	 */
	rejectedVenues: string[]
	/**
	 * Real names that contain a designator inside a longer proper name — "Lochaline Ferry Terminal", "Kingdom Hall". The
	 * whole string is `venue`; nothing in it is `unit`.
	 */
	longerNames: string[]
	/**
	 * Real names carrying a PROMOTED phrase in a shape the promotion does NOT cover — `Halle Rosengarten`, `PHOENIX
	 * Halle`, `Halle-Südstadt`. The other half of an `identifier-required` ruling, and the only thing that teaches the
	 * shape boundary rather than the word: de-DE has no `reject` row at all, so without this class its 168-hit confound
	 * (97 of them the CITY Halle) would go untaught while its 32-hit promotion got 11,000 rows.
	 */
	unpromotedShapes: string[]
}

/**
 * The name pools a source contributes. `attested` and `unpromotedShapes` come only from an extract — poi.db carries no
 * `tier` and no localized names, so it cannot say which side of a shape boundary a name sits on.
 */
export type NamePools = Pick<LegPools, "venues" | "attested" | "rejectedVenues" | "longerNames" | "unpromotedShapes">

/**
 * The pools a source that has nothing to say contributes — en-US has no OSM extract, and DE/ES/GB are outside poi.db's
 * four countries. Empty rather than absent so a leg's merge is unconditional.
 */
export const EMPTY_NAME_POOLS: NamePools = {
	venues: [],
	attested: [],
	rejectedVenues: [],
	longerNames: [],
	unpromotedShapes: [],
}

/**
 * What every pool reader needs to know about the leg it is reading for.
 */
export interface PoolQuery {
	promoted: readonly PromotedSurface[]
	rejectedPhrases: readonly string[]
	designatorPhrases: readonly string[]
	modifiers: readonly string[]
	english: boolean
}

/**
 * Is this name a designator sitting inside a longer proper name — the "Grand Central Terminal" class the span
 * proposer's second structural guard already knows about, and which the corpus has to agree with?
 */
function isLongerProperName(low: string, name: string, designatorPhrases: readonly string[]): boolean {
	return designatorPhrases.some((phrase) => containsPhrase(low, phrase) && !low.startsWith(phrase) && !/\d/.test(name))
}

/**
 * Read one OSM extract and split it into name pools.
 */
export async function readExtractPools(path: string, query: PoolQuery): Promise<NamePools> {
	const rows = await readSubVenueJSONL(path)
	const venues = new Set<string>()
	const attested = new Set<string>()
	const rejectedVenues = new Set<string>()
	const longerNames = new Set<string>()
	const unpromotedShapes = new Set<string>()

	for (const row of rows) {
		const name = (row.name ?? "").trim()

		if (!name || !isCleanName(name)) continue
		const low = name.toLowerCase()
		const venueSlot = isVenueSlotName(name)

		if (row.tier === "venue" && venueSlot) {
			venues.add(name)
		}

		for (const promoted of query.promoted) {
			if (!containsPhrase(low, promoted.phrase)) continue

			if (!hasPromotedShape(low, promoted, query.modifiers, query.english)) {
				if (venueSlot) {
					unpromotedShapes.add(name)
				}
			} else if (matchesPromotedShape(low, promoted, query.modifiers, query.english)) {
				attested.add(name)
			}
		}

		if (!venueSlot) continue

		if (query.rejectedPhrases.some((phrase) => containsPhrase(low, phrase))) {
			rejectedVenues.add(name)
		}

		if (isLongerProperName(low, name, query.designatorPhrases)) {
			longerNames.add(name)
		}
	}

	return {
		venues: [...venues],
		attested: [...attested],
		rejectedVenues: [...rejectedVenues],
		longerNames: [...longerNames],
		unpromotedShapes: [...unpromotedShapes],
	}
}

/**
 * Poi.db category ids this recipe reads, by category NAME (ids are assigned per build, so they are resolved at run time
 * out of `poi_category_codes`).
 *
 * The venue set is the transport + institution categories whose rows name a whole venue — exactly what
 * `overture-subvenue.ts` REJECTED as a lexicon source ("4,071 of them are the token `airport` in the aerodrome's own
 * name") and exactly what a venue slot wants. The confound set is that file's rejection list read as a source of
 * negatives: `shoe_store` contributes 708 hits of `wing` because Red Wing sells boots, and that is the row this shard
 * needs to see with `wing` NOT tagged `unit`.
 */
const POI_VENUE_CATEGORIES: readonly string[] = [
	"airport",
	"airport_terminal",
	"train_station",
	"hospital",
	"college_university",
]

const POI_CONFOUND_CATEGORIES: readonly string[] = [
	"shoe_store",
	"furniture_store",
	"home_decor_store",
	"town_hall",
	"martial_arts_club",
	"chicken_wings_restaurant",
	"fire_station",
]

/**
 * Read the venue + confound pools for a country out of `poi.db`.
 *
 * Poi.db is FOUR COUNTRIES — US 11,521,612 / CA 794,418 / FR 721,352 / MX 644,316 — so this is reachable for en-US and
 * fr-FR and nothing else, and a zero here is evidence of absence in four countries rather than in the world.
 */
export function readPOIPools(dbPath: PathBuilderLike, country: string, query: PoolQuery): NamePools {
	using db = new DatabaseClient<POIDatabase>(dbPath, { readOnly: true })

	const codes = db.prepare("select id, category from poi_category_codes").all() as Array<{
		id: number
		category: string
	}>

	const byName = new Map(codes.map((c) => [c.category, c.id]))
	const venueIDs = POI_VENUE_CATEGORIES.map((c) => byName.get(c)).filter((id): id is number => id != null)
	const confoundIDs = POI_CONFOUND_CATEGORIES.map((c) => byName.get(c)).filter((id): id is number => id != null)
	const wanted = [...venueIDs, ...confoundIDs]

	if (!wanted.length) throw new Error(`poi.db at ${dbPath} has none of the expected categories`)

	// One filtered full scan (measured 4.3 s over all 13,681,698 rows, 2026-08-05) rather than one
	// query per category: `poi` is `without rowid` on (h3_cell, category_id, …), so a category
	// predicate scans either way and scanning once is the cheaper shape.
	const rows = db
		.prepare(
			`select name, category_id from poi where country = ? and name is not null and category_id in (${wanted.map(() => "?").join(",")})`
		)
		.all(country, ...wanted) as Array<{ name: string; category_id: number }>

	const venueSet = new Set(venueIDs)
	const venues = new Set<string>()
	const rejectedVenues = new Set<string>()
	const longerNames = new Set<string>()

	for (const row of rows) {
		const name = row.name.trim()

		if (!isVenueSlotName(name)) continue
		const low = name.toLowerCase()

		if (venueSet.has(row.category_id)) {
			venues.add(name)
		}

		if (query.rejectedPhrases.some((phrase) => containsPhrase(low, phrase))) {
			rejectedVenues.add(name)
		}

		if (isLongerProperName(low, name, query.designatorPhrases)) {
			longerNames.add(name)
		}
	}

	return {
		venues: [...venues],
		attested: [],
		rejectedVenues: [...rejectedVenues],
		longerNames: [...longerNames],
		unpromotedShapes: [],
	}
}

/**
 * Merge two sources' name pools.
 */
export function mergeNamePools(a: NamePools, b: NamePools): NamePools {
	return {
		venues: [...a.venues, ...b.venues],
		attested: [...a.attested, ...b.attested],
		rejectedVenues: [...a.rejectedVenues, ...b.rejectedVenues],
		longerNames: [...a.longerNames, ...b.longerNames],
		unpromotedShapes: [...a.unpromotedShapes, ...b.unpromotedShapes],
	}
}

//#endregion

//#region Address context

/**
 * DE + ES address context. Both read through {@link readLocaleTuples}, the `locale` recipe's own streaming + reservoir
 * reader, so the CSV handling (quoted fields, CRLF, city-noise cleaning, the DE per-part region fallback) has exactly
 * one implementation.
 *
 * DE reads `europe.zip`'s two members rather than `oa-cache/de__*.zip`: the cached per-state zips the `locale` recipe
 * names are not materialized on this host, and the archive members are byte-identical to OA's current run (verified in
 * `corpus/AGENTS.md`'s "a file's mtime is not its data's vintage" note).
 */
const CONTEXT_PARTS: Readonly<Record<string, readonly LocalePart[]>> = {
	DE: [
		{ zip: dataRootPath("openaddresses", "europe.zip"), csv: "de/berlin.csv", region: "Berlin" },
		{ zip: dataRootPath("openaddresses", "europe.zip"), csv: "de/sn/statewide.csv", region: "Sachsen" },
	],
	ES: [{ path: dataRootPath("openaddresses", "extracted", "es", "countrywide.csv") }],
}

/**
 * Load the address skeletons every leg renders onto: GB / US / FR from the house-venue v3 tuples (the same 176,519 real
 * rows the `synth-house-venue` shard is built from, so the two shards' address halves are drawn from one pool), DE and
 * ES streamed out of OpenAddresses.
 */
export async function loadContextTuples(
	tuplesPath: PathBuilderLike,
	seed: number
): Promise<Map<string, LocaleBaseTuple[]>> {
	const byCountry = new Map<string, LocaleBaseTuple[]>()

	for await (const tuple of readShardTuples(tuplesPath)) {
		const country = String(tuple.country ?? "")

		if (!country || !tuple.locality || !tuple.street) continue

		const mapped: LocaleBaseTuple = {
			house_number: String(tuple.houseNumber ?? tuple.house_number ?? ""),
			street: String(tuple.street),
			locality: String(tuple.locality),
			region: String(tuple.region ?? ""),
			postcode: String(tuple.postcode ?? ""),
		}

		const list = byCountry.get(country)

		if (list) {
			list.push(mapped)
		} else {
			byCountry.set(country, [mapped])
		}
	}

	for (const [country, parts] of Object.entries(CONTEXT_PARTS)) {
		if (byCountry.has(country)) continue
		const pooled: LocaleBaseTuple[] = []

		for (const [index, part] of parts.entries()) {
			// A dedicated stream PRNG, seeded per part, so the input sample is reproducible without
			// perturbing the emit loop's draws (the `locale` recipe's rule, kept).
			const streamRandom = makeMulberry32(seed + index)

			for (const tuple of await readLocaleTuples(part, streamRandom)) {
				pooled.push(tuple)
			}
		}

		byCountry.set(country, pooled)
	}

	return byCountry
}

/**
 * The street-side confound classes, mined from the leg's OWN address tuples.
 *
 * Real streets, not invented ones. The 176,519-row context pool carries 195 GB `hall` streets, 114 GB `gate` streets,
 * 134 distinct GB `-gate` single tokens and a two-figure `<modifier> <designator>` population in both GB and US — small
 * absolute numbers, but every one of them a street somebody lives on, which is the property an invented list cannot
 * have.
 */
export interface StreetNegatives {
	designator: LocaleBaseTuple[]
	modifierDesignator: LocaleBaseTuple[]
	gateSuffix: LocaleBaseTuple[]
}

/**
 * Shortest token that can carry a `-gate` street suffix and still be a NAME rather than the bare word: `gate` itself is
 * four characters, so the class starts at five (`Highgate`, `Moorgate`, `Stonegate`).
 */
const MIN_GATE_SUFFIX_TOKEN_LENGTH = 5

export function buildStreetNegatives(
	context: readonly LocaleBaseTuple[],
	designatorPhrases: readonly string[],
	modifiers: readonly string[],
	country: string
): StreetNegatives {
	const designatorSet = new Set(designatorPhrases)
	const modifierSet = new Set(modifiers)
	const designator: LocaleBaseTuple[] = []
	const modifierDesignator: LocaleBaseTuple[] = []
	const gateSuffix: LocaleBaseTuple[] = []

	for (const tuple of context) {
		const tokens = tuple.street.toLowerCase().match(/[\p{L}]+/gu) ?? []
		let isDesignator = false
		let isPair = false

		for (const [index, token] of tokens.entries()) {
			if (designatorSet.has(token)) {
				isDesignator = true
			}

			if (index + 1 < tokens.length && modifierSet.has(token) && designatorSet.has(tokens[index + 1]!)) {
				isPair = true
			}

			if (country === "GB" && token.length >= MIN_GATE_SUFFIX_TOKEN_LENGTH && token.endsWith("gate")) {
				gateSuffix.push(tuple)
			}
		}

		if (isPair) {
			modifierDesignator.push(tuple)
		} else if (isDesignator) {
			designator.push(tuple)
		}
	}

	return { designator, modifierDesignator, gateSuffix }
}

//#endregion
