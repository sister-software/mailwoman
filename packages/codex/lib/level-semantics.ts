/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Maps floor designators to signed integer ordinals across locales, with ground at 0 as in Apple's IMDF.
 *
 *   The same numbered floor can mean different storeys. In the United States "1st floor" is ground, while in
 *   France, Germany and the UK it is one storey above ground. Designator words are keyed by language family,
 *   and numbering conventions are keyed by full locale.
 *
 *   The tables encode common building usage because no single authority publishes these conventions.
 *   Half-storeys round down: a mezzanine or upper ground maps to 0, and a lower ground maps to -1. Penthouse,
 *   roof and attic have no fixed ordinal and map to `undefined`.
 *
 * @see {@link https://register.apple.com/resources/imdf/Level/ imdf Level — `ordinal` (Apple Indoor Mapping Data Format)}
 */

/**
 * How a designator's ordinal is derived.
 *
 * - `"ground"` maps to 0.
 * - `"basement"` maps to the negated number.
 *   A bare basement maps to -1.
 * - `"numbered"` requires a number and applies the locale's {@link LevelOrdinalConvention}.
 * - `"fractionalAboveGround"` lies between ground and the first floor and maps to 0.
 * - `"fractionalBelowGround"` lies between the first basement and ground and maps to -1.
 * - `"special"` is relative to the top of the building and maps to `undefined`.
 * - `"fixedOrdinal"` maps to the row's `fixedOrdinal`.
 *   The Spanish principal floor is 1.
 */
export type LevelDesignatorKind =
	| "ground"
	| "basement"
	| "numbered"
	| "fractionalAboveGround"
	| "fractionalBelowGround"
	| "special"
	| "fixedOrdinal"

/**
 * One designator in a language family's lexicon.
 */
export interface LevelDesignatorRow {
	/**
	 * The canonical native spelling, in uppercase.
	 */
	code: string
	/**
	 * The native word followed by an English gloss in parentheses.
	 */
	name: string
	/**
	 * Recognized spellings, including the code, ASCII-folded forms and abbreviations.
	 */
	variants: readonly string[]
	kind: LevelDesignatorKind
	/**
	 * Whether a number usually follows the designator, as in "FL 3".
	 */
	requiresNumber: boolean
	/**
	 * The ordinal for a `"fixedOrdinal"` row.
	 */
	fixedOrdinal?: number
}

/**
 * English floor vocabulary for ordinal lookup.
 *
 * The US and AU designator modules hold the fuller per-system vocabularies used for parsing and synthesis.
 */
export const EN_LEVEL_DESIGNATORS = [
	{
		code: "FLOOR",
		name: "Floor",
		variants: ["FLOOR", "FL", "FLR", "LEVEL", "LVL"],
		kind: "numbered",
		requiresNumber: true,
	},
	{ code: "BASEMENT", name: "Basement", variants: ["BASEMENT", "BSMT", "B"], kind: "basement", requiresNumber: true },
	{ code: "PENTHOUSE", name: "Penthouse", variants: ["PENTHOUSE", "PH"], kind: "special", requiresNumber: false },
	{
		code: "GROUND",
		name: "Ground",
		variants: ["GROUND", "G", "GROUND FLOOR", "GF"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "LOWER GROUND",
		name: "Lower Ground",
		variants: ["LOWER GROUND", "LG"],
		kind: "fractionalBelowGround",
		requiresNumber: false,
	},
	{
		code: "UPPER GROUND",
		name: "Upper Ground",
		variants: ["UPPER GROUND", "UG"],
		kind: "fractionalAboveGround",
		requiresNumber: false,
	},
	{
		code: "MEZZANINE",
		name: "Mezzanine",
		variants: ["MEZZANINE", "MEZZ", "M"],
		kind: "fractionalAboveGround",
		requiresNumber: false,
	},
	{ code: "ROOF", name: "Roof", variants: ["ROOF", "RF"], kind: "special", requiresNumber: false },
] as const satisfies readonly LevelDesignatorRow[]

/**
 * French floor vocabulary.
 *
 * Canadian French uses the same words with a different numbering convention.
 */
export const FR_LEVEL_DESIGNATORS = [
	{
		code: "ÉTAGE",
		name: "Étage (Floor)",
		variants: ["ÉTAGE", "ETAGE", "ÉT", "ET"],
		kind: "numbered",
		requiresNumber: true,
	},
	{
		code: "RDC",
		name: "Rez-de-chaussée (Ground floor)",
		variants: ["RDC", "REZ-DE-CHAUSSÉE", "REZ-DE-CHAUSSEE", "REZ DE CHAUSSEE"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "SOUS-SOL",
		name: "Sous-sol (Basement)",
		variants: ["SOUS-SOL", "SOUS SOL", "SS"],
		kind: "basement",
		requiresNumber: true,
	},
	{
		code: "ENTRESOL",
		name: "Entresol (Mezzanine)",
		variants: ["ENTRESOL"],
		kind: "fractionalAboveGround",
		requiresNumber: false,
	},
] as const satisfies readonly LevelDesignatorRow[]

/**
 * German floor vocabulary.
 */
export const DE_LEVEL_DESIGNATORS = [
	{
		code: "OBERGESCHOSS",
		name: "Obergeschoss (Upper floor)",
		variants: ["OBERGESCHOSS", "OG"],
		kind: "numbered",
		requiresNumber: true,
	},
	{
		code: "ERDGESCHOSS",
		name: "Erdgeschoss (Ground floor)",
		variants: ["ERDGESCHOSS", "EG"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "UNTERGESCHOSS",
		name: "Untergeschoss (Basement)",
		variants: ["UNTERGESCHOSS", "UG"],
		kind: "basement",
		requiresNumber: true,
	},
	{
		code: "DACHGESCHOSS",
		name: "Dachgeschoss (Attic/roof floor)",
		variants: ["DACHGESCHOSS", "DG"],
		kind: "special",
		requiresNumber: false,
	},
	{
		code: "ZWISCHENGESCHOSS",
		name: "Zwischengeschoss (Mezzanine)",
		variants: ["ZWISCHENGESCHOSS", "ZG"],
		kind: "fractionalAboveGround",
		requiresNumber: false,
	},
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Spanish floor vocabulary.
 *
 * The positions of entresuelo and principal vary by city and building age.
 * This table maps entresuelo to 0 and principal to 1.
 */
export const ES_LEVEL_DESIGNATORS = [
	{ code: "PLANTA", name: "Planta/Piso (Floor)", variants: ["PLANTA", "PISO"], kind: "numbered", requiresNumber: true },
	{
		code: "PLANTA BAJA",
		name: "Planta Baja (Ground floor)",
		variants: ["PLANTA BAJA", "BAJO", "PB"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "ENTRESUELO",
		name: "Entresuelo (Mezzanine)",
		variants: ["ENTRESUELO"],
		kind: "fractionalAboveGround",
		requiresNumber: false,
	},
	{
		code: "PRINCIPAL",
		name: "Principal",
		variants: ["PRINCIPAL"],
		kind: "fixedOrdinal",
		requiresNumber: false,
		fixedOrdinal: 1,
	},
	{
		code: "SÓTANO",
		name: "Sótano (Basement)",
		variants: ["SÓTANO", "SOTANO"],
		kind: "basement",
		requiresNumber: true,
	},
	{
		code: "ÁTICO",
		name: "Ático (Attic/penthouse)",
		variants: ["ÁTICO", "ATICO"],
		kind: "special",
		requiresNumber: false,
	},
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Italian floor vocabulary.
 */
export const IT_LEVEL_DESIGNATORS = [
	{ code: "PIANO", name: "Piano (Floor)", variants: ["PIANO"], kind: "numbered", requiresNumber: true },
	{
		code: "PIANO TERRA",
		name: "Piano Terra (Ground floor)",
		variants: ["PIANO TERRA", "PT"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "SEMINTERRATO",
		name: "Seminterrato (Semi-basement)",
		variants: ["SEMINTERRATO"],
		kind: "fractionalBelowGround",
		requiresNumber: false,
	},
	{
		code: "ATTICO",
		name: "Attico (Attic/penthouse)",
		variants: ["ATTICO"],
		kind: "special",
		requiresNumber: false,
	},
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Portuguese floor vocabulary.
 */
export const PT_LEVEL_DESIGNATORS = [
	{ code: "ANDAR", name: "Andar (Floor)", variants: ["ANDAR"], kind: "numbered", requiresNumber: true },
	{
		code: "RÉS-DO-CHÃO",
		name: "Rés-do-chão (Ground floor)",
		variants: ["RÉS-DO-CHÃO", "RES-DO-CHAO", "RC"],
		kind: "ground",
		requiresNumber: false,
	},
	{ code: "CAVE", name: "Cave (Basement)", variants: ["CAVE"], kind: "basement", requiresNumber: true },
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Dutch floor vocabulary.
 */
export const NL_LEVEL_DESIGNATORS = [
	{
		code: "VERDIEPING",
		name: "Verdieping (Floor)",
		variants: ["VERDIEPING", "VERD"],
		kind: "numbered",
		requiresNumber: true,
	},
	{
		code: "BEGANE GROND",
		name: "Begane Grond (Ground floor)",
		variants: ["BEGANE GROND", "BG"],
		kind: "ground",
		requiresNumber: false,
	},
	{ code: "KELDER", name: "Kelder (Basement)", variants: ["KELDER"], kind: "basement", requiresNumber: true },
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Japanese floor vocabulary.
 *
 * Japanese addresses write floors as "2F" or "2階" and basements as "B1F" or "地下1階".
 * The table has no ground row because "1F" is the ground floor under the ja-JP numbering convention.
 */
export const JA_LEVEL_DESIGNATORS = [
	{ code: "F", name: "階 (Floor)", variants: ["F", "階"], kind: "numbered", requiresNumber: true },
	{ code: "B", name: "地下 (Basement)", variants: ["B", "地下"], kind: "basement", requiresNumber: true },
	{ code: "RF", name: "屋上 (Rooftop)", variants: ["RF", "屋上", "ROOFTOP"], kind: "special", requiresNumber: false },
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Swedish floor vocabulary.
 */
export const SV_LEVEL_DESIGNATORS = [
	{ code: "VÅNING", name: "Våning (Floor)", variants: ["VÅNING", "VANING"], kind: "numbered", requiresNumber: true },
	{
		code: "BOTTENVÅNING",
		name: "Bottenvåning (Ground floor)",
		variants: ["BOTTENVÅNING", "BOTTENVANING", "BV"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "KÄLLARE",
		name: "Källare (Basement)",
		variants: ["KÄLLARE", "KALLARE"],
		kind: "basement",
		requiresNumber: true,
	},
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Norwegian floor vocabulary.
 *
 * Norwegian has no standard word for the ground floor.
 * "Gateplan" (street level) is a regional term with lower confidence than the other ground rows.
 */
export const NO_LEVEL_DESIGNATORS = [
	{ code: "ETASJE", name: "Etasje (Floor)", variants: ["ETASJE"], kind: "numbered", requiresNumber: true },
	{
		code: "GATEPLAN",
		name: "Gateplan (Street/ground level)",
		variants: ["GATEPLAN"],
		kind: "ground",
		requiresNumber: false,
	},
	{ code: "KJELLER", name: "Kjeller (Basement)", variants: ["KJELLER"], kind: "basement", requiresNumber: true },
] as const satisfies readonly LevelDesignatorRow[]

/**
 * Danish floor vocabulary.
 * Danish addresses write the ground floor as "st." for stuen.
 */
export const DA_LEVEL_DESIGNATORS = [
	{ code: "ETAGE", name: "Etage (Floor)", variants: ["ETAGE"], kind: "numbered", requiresNumber: true },
	{
		code: "STUEN",
		name: "Stuen/Stueetage (Ground floor)",
		variants: ["STUEN", "STUEETAGE", "ST"],
		kind: "ground",
		requiresNumber: false,
	},
	{
		code: "KÆLDER",
		name: "Kælder (Basement)",
		variants: ["KÆLDER", "KAELDER"],
		kind: "basement",
		requiresNumber: true,
	},
] as const satisfies readonly LevelDesignatorRow[]

/**
 * A bare language tag that keys {@link LEVEL_DESIGNATORS_BY_FAMILY}.
 */
export type LevelLocaleFamily = "en" | "fr" | "de" | "es" | "it" | "pt" | "nl" | "ja" | "sv" | "no" | "da"

/**
 * Each language family's designator lexicon.
 *
 * Words are keyed by language because American and British English share them.
 */
export const LEVEL_DESIGNATORS_BY_FAMILY: Readonly<Record<LevelLocaleFamily, readonly LevelDesignatorRow[]>> = {
	en: EN_LEVEL_DESIGNATORS,
	fr: FR_LEVEL_DESIGNATORS,
	de: DE_LEVEL_DESIGNATORS,
	es: ES_LEVEL_DESIGNATORS,
	it: IT_LEVEL_DESIGNATORS,
	pt: PT_LEVEL_DESIGNATORS,
	nl: NL_LEVEL_DESIGNATORS,
	ja: JA_LEVEL_DESIGNATORS,
	sv: SV_LEVEL_DESIGNATORS,
	no: NO_LEVEL_DESIGNATORS,
	da: DA_LEVEL_DESIGNATORS,
}

/**
 * Maps each lowercased variant to its row, per family.
 *
 * Module load throws when a row has no variants, a variant is blank, or a variant repeats within a family.
 * A variant may repeat across families: "UG" means Upper Ground in English and Untergeschoss in German.
 */
const LEVEL_DESIGNATOR_LOOKUP_BY_FAMILY: ReadonlyMap<
	LevelLocaleFamily,
	ReadonlyMap<string, LevelDesignatorRow>
> = (() => {
	const byFamily = new Map<LevelLocaleFamily, ReadonlyMap<string, LevelDesignatorRow>>()

	for (const family of Object.keys(LEVEL_DESIGNATORS_BY_FAMILY) as LevelLocaleFamily[]) {
		const rows = LEVEL_DESIGNATORS_BY_FAMILY[family]
		const lookup = new Map<string, LevelDesignatorRow>()

		for (const row of rows) {
			if (!row.variants.length) {
				throw new Error(`[codex/level-semantics] family "${family}" designator "${row.code}" has no variants`)
			}

			for (const variant of row.variants) {
				if (!variant || !variant.trim()) {
					throw new Error(
						`[codex/level-semantics] family "${family}" designator "${row.code}" has an empty or blank variant`
					)
				}

				const key = variant.toLowerCase()
				const existing = lookup.get(key)

				if (existing) {
					throw new Error(
						`[codex/level-semantics] family "${family}" has a duplicate variant "${variant}" (designators "${existing.code}" and "${row.code}")`
					)
				}

				lookup.set(key, row)
			}
		}

		byFamily.set(family, lookup)
	}

	return byFamily
})()

const LEVEL_LOCALE_FAMILIES: ReadonlySet<LevelLocaleFamily> = new Set(
	Object.keys(LEVEL_DESIGNATORS_BY_FAMILY) as LevelLocaleFamily[]
)

/**
 * Language tags for Norwegian: the macrolanguage, Bokmål and Nynorsk.
 */
const NORWEGIAN_LANGUAGE_TAGS: ReadonlySet<string> = new Set(["no", "nb", "nn"])

/**
 * Splits a locale tag into a lowercased language and an uppercased region, which may be absent.
 */
function splitLocaleTag(locale: string): { language: string; region: string | undefined } {
	const [language, region] = locale.split("-")

	return { language: (language ?? "").toLowerCase(), region: region?.toUpperCase() }
}

/**
 * Returns the language family for a locale, or `undefined` when no lexicon exists for it.
 */
function localeFamily(locale: string): LevelLocaleFamily | undefined {
	const { language } = splitLocaleTag(locale)
	const family = NORWEGIAN_LANGUAGE_TAGS.has(language) ? "no" : language

	return LEVEL_LOCALE_FAMILIES.has(family as LevelLocaleFamily) ? (family as LevelLocaleFamily) : undefined
}

/**
 * A locale's floor-numbering convention.
 */
export interface LevelOrdinalConvention {
	/**
	 * Whether the first numbered floor is the ground floor.
	 *
	 * When true, as in the US, Canada and Japan, the ordinal is the number minus one.
	 * When false, as in the UK and continental Europe, the ordinal equals the number.
	 */
	readonly firstNumberedIsGround: boolean
}

/**
 * Numbering conventions for specific locales.
 *
 * English needs per-country entries because US and British buildings number floors differently.
 * Canadian locales follow North American practice, though some Quebec buildings differ.
 */
export const LEVEL_ORDINAL_CONVENTIONS: Readonly<Record<string, LevelOrdinalConvention>> = {
	"en-US": { firstNumberedIsGround: true },
	"en-CA": { firstNumberedIsGround: true },
	"en-GB": { firstNumberedIsGround: false },
	"fr-CA": { firstNumberedIsGround: true },
	"ja-JP": { firstNumberedIsGround: true },
}

/**
 * The numbering convention for a language family when the locale has no specific entry.
 *
 * English has no default because US and British buildings disagree,
 * so a bare "en" locale resolves to `undefined`.
 */
const FAMILY_DEFAULT_ORDINAL_CONVENTION: Partial<Record<LevelLocaleFamily, LevelOrdinalConvention>> = {
	fr: { firstNumberedIsGround: false },
	de: { firstNumberedIsGround: false },
	es: { firstNumberedIsGround: false },
	it: { firstNumberedIsGround: false },
	pt: { firstNumberedIsGround: false },
	nl: { firstNumberedIsGround: false },
	sv: { firstNumberedIsGround: false },
	no: { firstNumberedIsGround: false },
	da: { firstNumberedIsGround: false },
	ja: { firstNumberedIsGround: true },
}

/**
 * Returns the locale's own convention, then the family default, then `undefined`.
 */
function resolveOrdinalConvention(locale: string): LevelOrdinalConvention | undefined {
	const { language, region } = splitLocaleTag(locale)
	const normalized = region ? `${language}-${region}` : language

	if (LEVEL_ORDINAL_CONVENTIONS[normalized]) {
		return LEVEL_ORDINAL_CONVENTIONS[normalized]
	}

	const family = localeFamily(locale)

	return family ? FAMILY_DEFAULT_ORDINAL_CONVENTION[family] : undefined
}

/**
 * Finds a designator row by any variant in the locale's language family, ignoring case.
 *
 * Returns `undefined` when the family or the token is unknown.
 */
export function lookupLevelDesignator(designator: string, locale: string): LevelDesignatorRow | undefined {
	if (!designator || typeof designator !== "string") return undefined
	const family = localeFamily(locale)

	if (!family) return undefined

	return LEVEL_DESIGNATOR_LOOKUP_BY_FAMILY.get(family)?.get(designator.trim().toLowerCase())
}

/**
 * Returns whether `input` is a designator in the locale's language family, ignoring case.
 */
export function isLevelDesignatorToken(input: unknown, locale: string): boolean {
	return typeof input === "string" && lookupLevelDesignator(input, locale) !== undefined
}

/**
 * Maps a designator and number to a signed floor ordinal in `locale`, with ground at 0.
 *
 * Returns `undefined` when the family or designator is unknown, when the designator is
 * `"special"`, or when a `"numbered"` designator lacks a number or a resolvable convention.
 * A bare "en" locale has no convention.
 *
 * @example
 * 	levelToOrdinal("FL", 1, "en-US") // → 0 (US: 1st floor is ground)
 * 	levelToOrdinal("étage", 1, "fr-FR") // → 1 (FR: 1st étage is one storey above ground)
 * 	levelToOrdinal("EG", undefined, "de-DE") // → 0 (ground, number ignored)
 * 	levelToOrdinal("B", 1, "en-US") // → -1 (basement 1)
 * 	levelToOrdinal("F", 1, "ja-JP") // → 0 (JP: 1F is ground)
 * 	levelToOrdinal("B", 1, "ja-JP") // → -1 (JP: B1F)
 */
export function levelToOrdinal(designator: string, number: number | undefined, locale: string): number | undefined {
	const row = lookupLevelDesignator(designator, locale)

	if (!row) return undefined

	switch (row.kind) {
		case "ground":
			return 0
		case "fractionalAboveGround":
			return 0
		case "fractionalBelowGround":
			return -1
		case "special":
			return undefined
		case "fixedOrdinal":
			return row.fixedOrdinal
		case "basement":
			return -Math.abs(number ?? 1)
		case "numbered": {
			if (number === undefined) return undefined
			const convention = resolveOrdinalConvention(locale)

			if (!convention) return undefined

			return convention.firstNumberedIsGround ? number - 1 : number
		}
		default:
			return undefined
	}
}
