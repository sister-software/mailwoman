/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-locale LEVEL semantics — the fix for "Flr 1 means something different depending on where you
 *   are" (#1100, the secondary-address epic's second data deliverable). {@link "./us/unit-designator.ts"},
 *   {@link "./us/floor-designator.ts"}, and {@link "./au/level-designator.ts"} each standardize ONE
 *   address system's floor/level VOCABULARY — which surface tokens exist ("FL", "L 3", "Ground
 *   Floor"). This module standardizes the cross-locale ORDINAL SEMANTICS those tokens carry: the fact
 *   that "1st floor" names the SAME physical storey as "ground floor" in the United States
 *   (`firstNumberedIsGround: true`) but ONE STOREY ABOVE it in France, Germany, and most of
 *   continental Europe (`firstNumberedIsGround: false`), where ground already has its own name (RDC,
 *   EG, PLANTA BAJA, …) and claims ordinal 0 on its own.
 *
 *   This is inherently a MULTI-LOCALE module — unlike `us/`, `au/`, `fr/`, … it doesn't belong to one
 *   address system, so it lives at the codex root and is exported only from the root barrel
 *   (mirroring `address-system-conventions.ts` and `postcode-systems.ts`, the other cross-system root
 *   modules). It does not get its own `@mailwoman/codex/<x>` subpath.
 *
 *   Two tables do the work:
 *
 *   1. {@link LEVEL_DESIGNATORS_BY_FAMILY} — the designator LEXICON per LANGUAGE family (the surface
 *      vocabulary: FL/FLOOR/LVL/LEVEL, ÉTAGE/ÉT, OG/OBERGESCHOSS, …). Keyed by a bare language tag
 *      ("en", "fr", "de", …) because the WORDS don't vary by country — American and British English
 *      both say "floor", "basement", "penthouse".
 *   2. {@link LEVEL_ORDINAL_CONVENTIONS} — the ORDINAL CONVENTION per full locale ("en-US", "en-GB",
 *      …), because the NUMBERING varies by country even within one language: American and Canadian
 *      buildings both call the ground floor "the 1st floor"; British buildings, like the rest of the
 *      IMDF/continental-European convention locales, do not.
 *
 *   {@link levelToOrdinal} composes both: look up the designator's KIND in the locale's language
 *   family (ground / basement / numbered / fractional / special / fixed), then — for numbered
 *   designators only — apply the locale's numbering convention. IMDF (Apple's Indoor Mapping Data
 *   Format) is the schema precedent for encoding a level as a signed integer `ordinal` where ground is
 *   always 0; this table supplies the locale-aware mapping from a raw (designator, number) pair into
 *   that same ordinal space.
 *
 *   Data is convention encoded from common postal/building usage, not a single postal authority
 *   publication — level-numbering conventions are cultural, not regulatory, so no Pub-28-style single
 *   source exists for most of these locales. Retrieved/encoded 2026-07-13, epic #1100.
 *
 *   Deliberately-excluded ambiguities (handled by an explicit, documented rounding rule below, never a
 *   silent guess):
 *
 *   - **Spanish PRINCIPAL / ENTRESUELO**: pre-metric Spanish buildings run BAJO (0) → ENTRESUELO
 *     (~0.5) → PRINCIPAL (1) → PISO 1/2 (2), but the exact offset varies by city and building age.
 *     ENTRESUELO's true position (0.5) isn't representable as an integer ordinal; it floors to 0
 *     (grouped with ground) — a documented approximation, not an empirical claim. PRINCIPAL is a
 *     fixed, always-ordinal-1 designator (it names a specific floor by convention, not by a number the
 *     caller supplies).
 *   - **English LOWER GROUND / UPPER GROUND** (UK mixed-use buildings): sit at roughly -0.5 and +0.5
 *     relative to ground. Both round DOWN (floor): LOWER GROUND → -1 (grouped with the first basement
 *     level), UPPER GROUND → 0 (grouped with ground). Convention choices, not measurements.
 *   - **PENTHOUSE / ROOF / ATTIC / DACHGESCHOSS / ÁTICO / ATTICO**: named by relationship to the TOP of
 *     a SPECIFIC building, not by a fixed distance from ground — there is no locale-independent integer
 *     to assign. {@link levelToOrdinal} returns `undefined` for this designator kind rather than
 *     guessing.
 *   - **Nordic ground-floor vocabulary**: Danish STUEN/STUEETAGE is a well-attested standard term
 *     (the "st." you see on Danish addresses). Norwegian has no equally standard, universally-agreed
 *     single word for "ground floor" distinct from "1. etasje" in everyday use; GATEPLAN is included
 *     here for structural parity with the other Nordic tables but is a lower-confidence, regional
 *     inclusion — flagged in-line, not asserted as authoritative.
 *
 * @see {@link https://register.apple.com/resources/imdf/Level/ IMDF Level — `ordinal` (Apple Indoor Mapping Data Format)}
 */

/**
 * How a level designator's ordinal is derived. See the module header for the rationale behind each non-obvious kind.
 *
 * - `"ground"` — always ordinal 0 (RDC, EG, PLANTA BAJA, …).
 * - `"basement"` — ordinal is the negation of the trailing number, defaulting to 1 when the designator appears bare
 *   ("Basement" alone → -1, same as "B1").
 * - `"numbered"` — ordinal depends on the locale's {@link LevelOrdinalConvention} (US/CA/JP-style vs
 *   continental-European/IMDF-style); requires a number.
 * - `"fractionalAboveGround"` — conceptually between ground and the first numbered level (mezzanine, entresol/entresuelo,
 *   upper ground, German Zwischengeschoss); floors to ordinal 0.
 * - `"fractionalBelowGround"` — conceptually between the first basement level and ground (UK lower ground, Italian
 *   seminterrato); floors to ordinal -1.
 * - `"special"` — named by relationship to a SPECIFIC building's top (penthouse, roof, attic); no locale-independent
 *   ordinal exists. {@link levelToOrdinal} returns `undefined`.
 * - `"fixedOrdinal"` — a specific named floor with its own fixed ordinal, independent of any number the caller supplies
 *   (Spanish PRINCIPAL is always ordinal 1).
 */
export type LevelDesignatorKind =
	| "ground"
	| "basement"
	| "numbered"
	| "fractionalAboveGround"
	| "fractionalBelowGround"
	| "special"
	| "fixedOrdinal"

/** One row of a per-language-family level-designator lexicon. */
export interface LevelDesignatorRow {
	/** Canonical designator key (the language's native canonical spelling, uppercase). */
	code: string
	/** Human-readable name — the native word plus an English gloss in parentheses. */
	name: string
	/** Recognized surface variants, including the canonical code itself and common ASCII-folded / abbreviated spellings. */
	variants: readonly string[]
	/** How this designator maps to an ordinal — see {@link LevelDesignatorKind}. */
	kind: LevelDesignatorKind
	/** True when a secondary number typically follows ("FL 3", "B 2"); false for standalone designators ("EG", "RDC"). */
	requiresNumber: boolean
	/**
	 * Only present when `kind` is `"fixedOrdinal"` — the designator's own fixed ordinal, independent of any passed
	 * number.
	 */
	fixedOrdinal?: number
}

/**
 * English (American, British, Canadian, Australian, …) floor/level vocabulary. This is the GENERIC English lexicon for
 * the ordinal-semantics table; it doesn't replace the more detailed per-system lexicons in
 * {@link "./us/floor-designator.ts"} (USPS Pub-28 C2) or {@link "./au/level-designator.ts"} (AS 4590.1 / AMAS) — those
 * drive span-proposer/synthesis vocabulary for their own address system. This table exists to answer a narrower
 * question for ANY English-speaking locale: given a designator + number, what ordinal does it name.
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

/** French (France, and — for the vocabulary, not the numbering convention — Francophone Canada) floor/level vocabulary. */
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

/** German floor/level vocabulary (the -geschoss family). */
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
 * Spanish floor/level vocabulary. PRINCIPAL and ENTRESUELO offsets vary by city and building age (see the module
 * header) — encoded here as a single convention, not an empirical universal.
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

/** Italian floor/level vocabulary. */
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

/** Portuguese floor/level vocabulary. */
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

/** Dutch floor/level vocabulary. */
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
 * Japanese (and generic CJK numeral+letter) floor/level vocabulary. Japanese addresses write the numbered floor as a
 * trailing "F" suffix on the number ("2F", "地下1F"/"B1F") or the kanji "階" ("2階"); there is no distinct bare word for
 * "ground floor" the way RDC/EG/PLANTA BAJA exist in Europe — "1F"/"1階" already IS ground (handled by the `"numbered"`
 * kind + the ja-JP `firstNumberedIsGround: true` convention, not a separate `"ground"` row). "B" (and "地下", literally
 * "underground") name the basement count the same way English "B1" does.
 */
export const JA_LEVEL_DESIGNATORS = [
	{ code: "F", name: "階 (Floor)", variants: ["F", "階"], kind: "numbered", requiresNumber: true },
	{ code: "B", name: "地下 (Basement)", variants: ["B", "地下"], kind: "basement", requiresNumber: true },
	{ code: "RF", name: "屋上 (Rooftop)", variants: ["RF", "屋上", "ROOFTOP"], kind: "special", requiresNumber: false },
] as const satisfies readonly LevelDesignatorRow[]

/** Swedish floor/level vocabulary. */
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
 * Norwegian floor/level vocabulary. GATEPLAN ("street level") is a lower-confidence, regional inclusion for the
 * ground-floor row — see the module header's Nordic-vocabulary caveat.
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

/** Danish floor/level vocabulary. STUEN/STUEETAGE ("st.") is the standard ground-floor term seen on Danish addresses. */
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

/** A bare language-family tag — the key into {@link LEVEL_DESIGNATORS_BY_FAMILY}. */
export type LevelLocaleFamily = "en" | "fr" | "de" | "es" | "it" | "pt" | "nl" | "ja" | "sv" | "no" | "da"

/** Every language family's level-designator lexicon, keyed by bare language tag. */
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
 * Per-family inverse lookup (lowercase variant → its designator row), built once at module load. Structural integrity
 * check runs here: every row must carry at least one non-blank variant, and no variant may repeat WITHIN a family
 * (case-insensitive) — a malformed table throws loudly at import time rather than silently producing an ambiguous
 * lexicon. Collisions ACROSS families are expected and fine (that's the entire point of this module: "UG" is Upper
 * Ground in English but Untergeschoss in German — same token, different family, different meaning).
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
			if (row.variants.length === 0) {
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

/** BCP-47-ish language tags that fold into the Norwegian family (Bokmål, Nynorsk, and the deprecated macrolanguage tag). */
const NORWEGIAN_LANGUAGE_TAGS: ReadonlySet<string> = new Set(["no", "nb", "nn"])

/**
 * Split `locale` into `{ language, region }`, lowercasing the language and uppercasing the region. Tolerant of a bare
 * language tag (no region).
 */
function splitLocaleTag(locale: string): { language: string; region: string | undefined } {
	const [language, region] = locale.split("-")

	return { language: (language ?? "").toLowerCase(), region: region?.toUpperCase() }
}

/** Resolve a BCP-47-ish locale tag to its {@link LevelLocaleFamily}, or `undefined` if this module has no lexicon for it. */
function localeFamily(locale: string): LevelLocaleFamily | undefined {
	const { language } = splitLocaleTag(locale)
	const family = NORWEGIAN_LANGUAGE_TAGS.has(language) ? "no" : language

	return LEVEL_LOCALE_FAMILIES.has(family as LevelLocaleFamily) ? (family as LevelLocaleFamily) : undefined
}

/**
 * The locale's level-numbering convention: does the FIRST numbered level ("1st floor", "1F", "étage 1", …) coincide
 * with ground (ordinal 0), or sit one storey above it?
 */
export interface LevelOrdinalConvention {
	/**
	 * True for the US/Canada/Japan-style convention, where the first numbered level IS ground ("1st floor" = ground floor
	 * = ordinal 0, so ordinal = number - 1). False for the continental-European / IMDF-style convention, where ground has
	 * its own designator (RDC, EG, PLANTA BAJA, …) and the first NUMBERED level sits one storey above it (ordinal =
	 * number) — also the convention in the UK.
	 */
	readonly firstNumberedIsGround: boolean
}

/**
 * Per-FULL-LOCALE ordinal convention overrides. Keyed by full locale (not bare language family) because English splits
 * by country even though the vocabulary doesn't: American and Canadian buildings number the ground floor "1"; British
 * buildings do not. "CA" (English or French) buckets with the US/Japan convention per real-world North American
 * building-code practice, though individual Quebec buildings can and do vary.
 */
export const LEVEL_ORDINAL_CONVENTIONS: Readonly<Record<string, LevelOrdinalConvention>> = {
	"en-US": { firstNumberedIsGround: true },
	"en-CA": { firstNumberedIsGround: true },
	"en-GB": { firstNumberedIsGround: false },
	"fr-CA": { firstNumberedIsGround: true },
	"ja-JP": { firstNumberedIsGround: true },
}

/**
 * Default convention per language family, used when {@link levelToOrdinal} is given a bare-language locale ("fr" with no
 * country) or a country this table doesn't specifically override. Every entry here follows the
 * continental-European/IMDF convention (ground is its own designator; numbered floors start at 1 for the storey above)
 * except Japanese, which follows the US/CA convention. English has NO family-wide default — American/Canadian and
 * British buildings disagree, so a bare "en" locale intentionally resolves to `undefined` rather than guessing.
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
 * Resolve the ordinal convention for `locale`: an exact full-locale override, else the language family's default, else
 * `undefined`.
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
 * Look up a level designator (by canonical code, abbreviation, or any recognized variant) within a locale's language
 * family. Case-insensitive. Returns `undefined` when the locale's family is unknown to this module, or the token isn't
 * a recognized designator in that family.
 */
export function lookupLevelDesignator(designator: string, locale: string): LevelDesignatorRow | undefined {
	if (!designator || typeof designator !== "string") return undefined
	const family = localeFamily(locale)

	if (!family) return undefined

	return LEVEL_DESIGNATOR_LOOKUP_BY_FAMILY.get(family)?.get(designator.trim().toLowerCase())
}

/** True when `input` is a recognized level designator (case-insensitive) in `locale`'s language family. */
export function isLevelDesignatorToken(input: unknown, locale: string): boolean {
	return typeof input === "string" && lookupLevelDesignator(input, locale) !== undefined
}

/**
 * Map a (designator, number) pair to an IMDF-style signed integer ordinal, given the semantics of `locale`. Ground is
 * always 0. Returns `undefined` when:
 *
 * - `locale`'s language family has no lexicon in this module,
 * - `designator` isn't a recognized token in that family,
 * - The designator is `"special"` (penthouse/roof/attic — no locale-independent ordinal exists), or
 * - The designator is `"numbered"` but either `number` is missing or the locale has no resolvable ordinal convention (a
 *   bare "en" locale, for example).
 *
 * @example
 * 	levelToOrdinal("FL", 1, "en-US") // → 0 (US: 1st floor IS ground)
 * 	levelToOrdinal("étage", 1, "fr-FR") // → 1 (FR: 1st étage is one storey above ground)
 * 	levelToOrdinal("EG", undefined, "de-DE") // → 0 (ground, number ignored)
 * 	levelToOrdinal("B", 1, "en-US") // → -1 (basement 1)
 * 	levelToOrdinal("F", 1, "ja-JP") // → 0 (JP: 1F IS ground)
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
