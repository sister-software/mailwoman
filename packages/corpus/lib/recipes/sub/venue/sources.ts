/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locale-specific vocabulary, identifier rules, and source pools for `sub-venue`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { sample } from "@mailwoman/core/random"
import type { POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { LocaleBaseTuple } from "#surfaces/locale"
import { weightedPick } from "#synthesizers/utils"
import {
	classifyIdentifier,
	readSubVenueJSONL,
	type SubVenueLexiconTable,
	SUBVENUE_PROMOTIONS,
	type SubVenuePromotion,
} from "#tools"

// #region Lexicon

/**
 * Resolve the packaged lexicon path.
 */
export function defaultLexiconPath(): string {
	return resolveModulePath("@mailwoman/corpus/data/sub-venue-lexicon.json")
}

/**
 * Read the lexicon; invalid JSON fails the build.
 */
export async function readSubVenueLexicon(path: string = defaultLexiconPath()): Promise<SubVenueLexiconTable> {
	return await readLocalJSONFile<SubVenueLexiconTable>(path)
}

// #endregion

// #region Name filters

/**
 * Maximum venue-name length; longer values are likely descriptions.
 */
const MAX_VENUE_NAME_LENGTH = 44

/**
 * Minimum venue-name length.
 */
const MIN_NAME_LENGTH = 4

/**
 * Maximum token count for attested sub-venue names.
 */
const MAX_ATTESTED_TOKENS = 4

/**
 * Reject names with route punctuation, no letters, or a single lowercase code.
 */
export function isCleanName(name: string): boolean {
	if (name.length < MIN_NAME_LENGTH || name.length > MAX_VENUE_NAME_LENGTH) return false

	// Reject punctuation used to separate route qualifiers.
	if (/[/;,:()[\]<>|]/.test(name)) return false

	if (!/\p{L}/u.test(name)) return false

	// Reject lowercase single-token codes.
	if (!name.includes(" ") && name === name.toLowerCase()) return false

	return true
}

/**
 * Leading words that indicate street types or stop descriptions.
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
 * English street-type words rejected at the end of names.
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
 * Check whether a name can fill the venue slot.
 */
export function isVenueSlotName(name: string): boolean {
	if (!isCleanName(name)) return false
	const words = name.toLowerCase().match(/[\p{L}]+/gu) ?? []

	if (!words.length) return false

	if (NON_VENUE_HEAD_WORDS.has(words[0]!)) return false
	const tail = words.at(-1)!

	return !STREET_TAIL_WORDS.has(tail) && !GERMAN_STREET_TAIL.test(tail)
}

// #endregion

// #region Promotions

/**
 * Locale-specific designator and surface, with its shape constraints.
 */
export interface PromotedSurface {
	designatorID: string
	phrase: string
	/**
	 * Title-cased rendering form.
	 */
	surface: string
	identifierRequired: boolean
	modifierEligible: boolean
}

/**
 * Title-case a single-token designator phrase for rendering.
 */
export function titleCase(phrase: string): string {
	return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * Match phrases at word boundaries, avoiding cases such as `gate` in `Briggate`.
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
 * Identifier shapes suitable for sampling.
 *
 * Exclude the `other` bucket, which contains malformed or unrelated codes.
 */
const USABLE_IDENTIFIER_SHAPES: ReadonlySet<string> = new Set([
	"digit",
	"letter",
	"letter-digit",
	"digit-letter",
	"range",
])

/**
 * Sign identifier atom: a short number, one letter, letter-number, or number-letter.
 *
 * Multi-letter prefixes are excluded because they commonly encode network
 * or campus codes rather than visible sign identifiers.
 */
const SIGN_IDENTIFIER_ATOM = /^(?:[0-9]{1,3}|[A-Za-z]|[A-Za-z][0-9]{1,3}|[0-9]{1,3}[A-Za-z]{1,2})$/

/**
 * Check whether a value is a sign identifier or a range of two; shape
 * classification alone does not validate it.
 */
export function isSignIdentifier(value: string): boolean {
	const parts = value.split(/[/-]/)

	if (parts.length > 2 || parts.some((p) => !p)) return false

	return parts.every((part) => SIGN_IDENTIFIER_ATOM.test(part))
}

/**
 * Check whether an extract name matches an allowed promoted shape: `<phrase> <identifier>`,
 * or an eligible English `<modifier> <phrase>`.
 *
 * A phrase mention alone does not attest a sub-venue; validate its follower as an identifier.
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
 * Match a promoted shape and enforce the maximum sub-venue token count.
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
 * Return locale-eligible `unit` surfaces.
 *
 * English uses shipped designators; promotions add localized forms and rejections
 * prevent this recipe from generating positives for rejected terms.
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
			// Promotions do not expand modifier eligibility; only English legs use it.
			modifierEligible: Boolean(designator?.modifierEligible) && promotion.shape !== "identifier-required",
		})
	}

	return [...out.values()].toSorted((a, b) => a.phrase.localeCompare(b.phrase))
}

/**
 * Return phrases rejected for this locale.
 */
export function rejectedPhrasesFor(
	locale: string,
	promotions: readonly SubVenuePromotion[] = SUBVENUE_PROMOTIONS
): string[] {
	return promotions.filter((p) => p.decision === "reject" && p.locale === locale).map((p) => p.phrase)
}

// #endregion

// #region Identifier sampling

interface ShapeBucket {
	shape: string
	observations: number
	examples: string[]
}

/**
 * Per-designator distributions and a pooled fallback for one region.
 */
export interface IdentifierModel {
	byDesignator: Map<string, ShapeBucket[]>
	pooled: ShapeBucket[]
}

/**
 * Sign-oriented designators used for the pooled fallback; exclude platform and station network codes.
 */
const POOLED_IDENTIFIER_DESIGNATORS: readonly string[] = ["gate", "terminal", "campus"]

/**
 * Minimum observations required to use a region/designator distribution;
 * smaller samples use the regional pool.
 */
const MIN_OWN_SHAPE_OBSERVATIONS = 20

/**
 * Build a regional identifier model from the lexicon's `identifierShapes`.
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
 * Sample an identifier using the designator's distribution when sufficiently populated,
 * otherwise the regional pool.
 *
 * Weight shapes by observation count and choose an example uniformly within the selected shape.
 */
export function sampleIdentifier(model: IdentifierModel, designatorID: string, random: () => number): string | null {
	const own = model.byDesignator.get(designatorID) ?? []
	const ownTotal = own.reduce((sum, b) => sum + b.observations, 0)
	const buckets = ownTotal >= MIN_OWN_SHAPE_OBSERVATIONS ? own : model.pooled

	if (!buckets.length) return null

	// Preserve the existing strict bucket boundary and seeded output.
	const bucket = weightedPick(buckets, random, (b) => b.observations, { inclusive: false })

	return sample(bucket.examples, random)
}

// #endregion

// #region Pools

/**
 * Source pools loaded once per recipe leg.
 */
export interface LegPools {
	context: LocaleBaseTuple[]
	/**
	 * Real names for the venue slot, such as stations, airports, campuses, hospitals, and rail venues.
	 */
	venues: string[]
	/**
	 * Extract names matching promoted surfaces and their shape constraints.
	 */
	attested: string[]
	/**
	 * Names containing locale-rejected surfaces, used in negative venue rows.
	 */
	rejectedVenues: string[]
	/**
	 * Names containing a designator as part of a longer name; label the whole string as `venue`, not `unit`.
	 */
	longerNames: string[]
	/**
	 * Names containing a promoted phrase without its required shape,
	 * teaching the model the promotion boundary.
	 */
	unpromotedShapes: string[]
}

/**
 * Name pools supplied by a source.
 *
 * Only extracts provide `attested` and `unpromotedShapes`, because POI data has no tier or localized names.
 */
export type NamePools = Pick<LegPools, "venues" | "attested" | "rejectedVenues" | "longerNames" | "unpromotedShapes">

/**
 * Empty pools for sources unavailable to a locale; keeping arrays present allows unconditional merging.
 */
export const EMPTY_NAME_POOLS: NamePools = {
	venues: [],
	attested: [],
	rejectedVenues: [],
	longerNames: [],
	unpromotedShapes: [],
}

/**
 * Locale-specific filters required by pool readers.
 */
export interface PoolQuery {
	promoted: readonly PromotedSurface[]
	rejectedPhrases: readonly string[]
	designatorPhrases: readonly string[]
	modifiers: readonly string[]
	english: boolean
}

/**
 * Check whether a designator occurs inside a longer proper name without a numeric identifier.
 */
function isLongerProperName(low: string, name: string, designatorPhrases: readonly string[]): boolean {
	return designatorPhrases.some((phrase) => containsPhrase(low, phrase) && !low.startsWith(phrase) && !/\d/.test(name))
}

/**
 * Read an OSM extract and classify names into source pools.
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
 * POI categories used for venue examples and confound negatives.
 * Resolve IDs from `poi_category_codes` at runtime.
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
 * Read venue and confound pools from `poi.db`.
 *
 * Its limited country coverage means an empty result does not prove global absence.
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

	// Scan once for all requested categories; separate queries would repeat the table scan.
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
 * Combine two sources' name pools.
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

// #endregion
