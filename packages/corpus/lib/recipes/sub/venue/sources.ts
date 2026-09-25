/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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

/**
 * Resolves the path of the packaged sub-venue lexicon.
 */
export function defaultLexiconPath(): string {
	return resolveModulePath("@mailwoman/corpus/data/sub-venue-lexicon.json")
}

/**
 * Reads the sub-venue lexicon and throws on invalid JSON.
 */
export async function readSubVenueLexicon(path: string = defaultLexiconPath()): Promise<SubVenueLexiconTable> {
	return await readLocalJSONFile<SubVenueLexiconTable>(path)
}

const MAX_VENUE_NAME_LENGTH = 44

const MIN_NAME_LENGTH = 4

const MAX_ATTESTED_TOKENS = 4

/**
 * Reports whether a name has a usable length, contains a letter, and lacks route punctuation.
 *
 * The check also rejects a single lowercase token, which is usually a code.
 */
export function isCleanName(name: string): boolean {
	if (name.length < MIN_NAME_LENGTH || name.length > MAX_VENUE_NAME_LENGTH) return false

	if (/[/;,:()[\]<>|]/.test(name)) return false

	if (!/\p{L}/u.test(name)) return false

	if (!name.includes(" ") && name === name.toLowerCase()) return false

	return true
}

const NON_VENUE_HEAD_WORDS: ReadonlySet<string> = new Set([
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

	"rue",
	"boulevard",
	"chemin",
	"impasse",
	"allée",
	"allee",
	"route",
	"quai",
	"place",

	"calle",
	"carrer",
	"avenida",
	"avinguda",
	"carretera",
	"plaza",
	"paseo",
	"camino",

	"straße",
	"strasse",
	"weg",
	"platz",
	"gasse",
])

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
 * Reports whether a clean name can fill the venue slot.
 *
 * The check rejects names that start with a street or stop word or end with a street type.
 */
export function isVenueSlotName(name: string): boolean {
	if (!isCleanName(name)) return false
	const words = name.toLowerCase().match(/[\p{L}]+/gu) ?? []

	if (!words.length) return false

	if (NON_VENUE_HEAD_WORDS.has(words[0]!)) return false
	const tail = words.at(-1)!

	return !STREET_TAIL_WORDS.has(tail) && !GERMAN_STREET_TAIL.test(tail)
}

/**
 * A designator phrase that may produce positives in one locale, with its shape constraints.
 */
export interface PromotedSurface {
	designatorID: string
	phrase: string

	/**
	 * The title-cased form used when rendering the designator.
	 */
	surface: string
	identifierRequired: boolean
	modifierEligible: boolean
}

/**
 * Uppercases the first character of a phrase.
 */
export function titleCase(phrase: string): string {
	return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * Reports whether a lowercased name contains the phrase at word boundaries.
 *
 * The boundary check keeps `gate` from matching inside `Briggate`.
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

const USABLE_IDENTIFIER_SHAPES: ReadonlySet<string> = new Set([
	"digit",
	"letter",
	"letter-digit",
	"digit-letter",
	"range",
])

const SIGN_IDENTIFIER_ATOM = /^(?:[0-9]{1,3}|[A-Za-z]|[A-Za-z][0-9]{1,3}|[0-9]{1,3}[A-Za-z]{1,2})$/

/**
 * Reports whether a value is a short sign identifier, such as `12`, `B` or `A3`,
 * or a range of two identifiers joined by `-` or `/`.
 *
 * Shape classification alone accepts some values that this check rejects, so callers apply both.
 */
export function isSignIdentifier(value: string): boolean {
	const parts = value.split(/[/-]/)

	if (parts.length > 2 || parts.some((p) => !p)) return false

	return parts.every((part) => SIGN_IDENTIFIER_ATOM.test(part))
}

/**
 * Reports whether a lowercased name uses a promoted phrase as `<phrase> <identifier>`,
 * or as an English `<modifier> <phrase>` when the designator allows it.
 *
 * A bare mention of the phrase returns `false` because it does not show that the name is a sub-venue.
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
 * Applies {@link hasPromotedShape} to names of at most four tokens.
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
 * Returns the designator surfaces that may produce `unit` positives in a locale.
 *
 * English locales get every shipped designator.
 * Every locale gets its promoted phrases.
 *
 * The function removes any pair that the ledger rejects for the locale.
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

			modifierEligible: Boolean(designator?.modifierEligible) && promotion.shape !== "identifier-required",
		})
	}

	return [...out.values()].toSorted((a, b) => a.phrase.localeCompare(b.phrase))
}

/**
 * Returns the phrases that the promotion ledger rejects for a locale.
 */
export function rejectedPhrasesFor(
	locale: string,
	promotions: readonly SubVenuePromotion[] = SUBVENUE_PROMOTIONS
): string[] {
	return promotions.filter((p) => p.decision === "reject" && p.locale === locale).map((p) => p.phrase)
}

interface ShapeBucket {
	shape: string
	observations: number
	examples: string[]
}

/**
 * One region's identifier shape distributions, per designator and pooled.
 */
export interface IdentifierModel {
	byDesignator: Map<string, ShapeBucket[]>
	pooled: ShapeBucket[]
}

const POOLED_IDENTIFIER_DESIGNATORS: readonly string[] = ["gate", "terminal", "campus"]

const MIN_OWN_SHAPE_OBSERVATIONS = 20

/**
 * Builds a region's identifier model from the lexicon's `identifierShapes`.
 *
 * The pooled fallback combines the gate, terminal and campus distributions.
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
 * Samples an identifier for a designator, weighting shapes by observation count.
 *
 * A designator with fewer than 20 observations of its own uses the pooled distribution.
 */
export function sampleIdentifier(model: IdentifierModel, designatorID: string, random: () => number): string | null {
	const own = model.byDesignator.get(designatorID) ?? []
	const ownTotal = own.reduce((sum, b) => sum + b.observations, 0)
	const buckets = ownTotal >= MIN_OWN_SHAPE_OBSERVATIONS ? own : model.pooled

	if (!buckets.length) return null

	const bucket = weightedPick(buckets, random, (b) => b.observations, { inclusive: false })

	return sample(bucket.examples, random)
}

/**
 * The address context and name pools for one recipe leg.
 */
export interface LegPools {
	context: LocaleBaseTuple[]

	/**
	 * Real venue-tier names that fit the venue slot, such as stations, airports, campuses and hospitals.
	 */
	venues: string[]

	/**
	 * Extract names of at most four tokens that use a promoted phrase in its required shape.
	 */
	attested: string[]

	/**
	 * Venue names that contain a phrase rejected for the locale.
	 */
	rejectedVenues: string[]

	/**
	 * Names that contain a designator inside a longer proper name, so the whole string is a `venue`.
	 */
	longerNames: string[]

	/**
	 * Venue names that contain a promoted phrase without its required shape.
	 */
	unpromotedShapes: string[]
}

/**
 * The name pools that one source contributes to a recipe leg.
 *
 * Only OSM extracts fill `attested` and `unpromotedShapes`, because POI data has no tier or localized names.
 */
export type NamePools = Pick<LegPools, "venues" | "attested" | "rejectedVenues" | "longerNames" | "unpromotedShapes">

/**
 * Empty name pools for a source that a leg lacks.
 */
export const EMPTY_NAME_POOLS: NamePools = {
	venues: [],
	attested: [],
	rejectedVenues: [],
	longerNames: [],
	unpromotedShapes: [],
}

/**
 * The locale-specific filters that the pool readers apply.
 */
export interface PoolQuery {
	promoted: readonly PromotedSurface[]
	rejectedPhrases: readonly string[]
	designatorPhrases: readonly string[]
	modifiers: readonly string[]
	english: boolean
}

function isLongerProperName(low: string, name: string, designatorPhrases: readonly string[]): boolean {
	return designatorPhrases.some((phrase) => containsPhrase(low, phrase) && !low.startsWith(phrase) && !/\d/.test(name))
}

/**
 * Reads an OSM sub-venue extract and sorts its names into name pools.
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
 * Reads the venue and confound name pools for one country from `poi.db`.
 *
 * The database covers only a few countries, so an empty result may reflect missing coverage.
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
 * Concatenates two sources' name pools.
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
