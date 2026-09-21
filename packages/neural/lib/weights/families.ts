/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The weights-family registry — which model graphs exist, which locales each one serves, and what routes an input to
 *   one.
 *
 *   A weights family is one model graph plus the vocabulary artifact that graph was trained against, shared by one or
 *   more locales. Two families exist: the Latin SentencePiece graph in `@mailwoman/neural-weights-en-us`, and the
 *   character graph in `@mailwoman/neural-weights-cjk`. Every other `neural-weights-*` package is an overlay carrying
 *   retrieval artifacts — an FST, a place-pair index, a postcode binary, lexicons — and inherits its graph through
 *   `mailwoman.baseWeights`.
 *
 *   Before this registry the second family was two module constants in `#classifier/script-router` (`FAMILY` and
 *   `FAMILY_SCRIPTS`), so a third family could not be named without editing them, and no file stated which locale
 *   belonged to which graph. That mapping is the thing a per-locale specialist would extend, and the thing a
 *   repository check needs in order to refuse a package that belongs to none.
 *
 *   {@linkcode FAMILIES} declares the topology. It does not decide serving: {@linkcode routeFamilyForText} reads only
 *   the predicates a family declares, and today only the CJK family declares any. A family with no predicate is
 *   reachable through the caller's locale and never through routing, which is what keeps every Latin request on the
 *   graph it reaches now.
 */

import type { QueryShape } from "@mailwoman/query-shape"

/**
 * How a family's graph reads its input.
 *
 * `sentencepiece` consumes subword ids from `tokenizer.model`; `char` consumes
 * code points indexed by `char-vocab.json`.
 * The value matches the `encoder` field a model card declares.
 */
export const FamilyEncoder = {
	SentencePiece: "sentencepiece",
	Char: "char",
} as const

export type FamilyEncoder = (typeof FamilyEncoder)[keyof typeof FamilyEncoder]

/**
 * The vocabulary artifact each encoder requires beside `model.onnx`.
 *
 * A standalone family package ships both files.
 * An overlay ships neither and resolves them from its base.
 */
export const FAMILY_VOCABULARY_ARTIFACT: Readonly<Record<FamilyEncoder, string>> = {
	[FamilyEncoder.SentencePiece]: "tokenizer.model",
	[FamilyEncoder.Char]: "char-vocab.json",
}

/**
 * Why a routing decision named the family it named.
 *
 * `caller` is the ordinary path: no predicate claimed the input, so it runs on
 * the locale the caller opened the process with.
 * The two script readings are distinguished because they disagree on the case the
 * segment rule exists for — a Han address line beside a Latin province folds to `mixed`
 * and only `script-segment` reaches it.
 */
export const RouteSource = {
	/**
	 * No family predicate claimed the input.
	 *
	 * It runs on the caller's locale.
	 */
	Caller: "caller",
	/**
	 * The locale hint's whole-input script rule named a locale whose family differs from the caller's.
	 */
	Script: "script",
	/**
	 * Some comma segment is written wholly in a script the family serves, while the whole input is not.
	 */
	ScriptSegment: "script-segment",
	/**
	 * A family's locale predicate claimed the input.
	 *
	 * No family declares one today.
	 */
	Locale: "locale",
} as const

export type RouteSource = (typeof RouteSource)[keyof typeof RouteSource]

/**
 * What a router decided for one input, and on what evidence.
 *
 * `family` is `undefined` when no predicate claimed the input, and
 * {@linkcode RoutingDecision.abstainedBecause} then says which reading declined.
 * A caller that wants only the answer reads `family`; a caller measuring a router — confusion
 * matrix, abstention rate, false routes by country — needs the reason, and reconstructing
 * it from the answer alone is impossible once two predicates can name the same family.
 */
export interface RoutingDecision {
	/**
	 * The family this input routes to, or `undefined` to stay on the caller's locale.
	 */
	family: string | undefined
	source: RouteSource
	/**
	 * How strongly the reading claims the input, in `[0, 1]`.
	 *
	 * The script predicates are rules rather than scorers and answer `1` when they fire,
	 * so this carries information only once a scored predicate exists.
	 */
	confidence: number
	/**
	 * Which reading declined, when `family` is `undefined`.
	 *
	 * Absent on a decision that named a family.
	 */
	abstainedBecause?: string
}

/**
 * One model graph and the locales it serves.
 */
export interface WeightsFamily {
	/**
	 * The family id.
	 *
	 * It is also the locale segment `resolveWeights` uses for the graph package,
	 * so `cjk` resolves `@mailwoman/neural-weights-cjk`.
	 */
	family: string
	/**
	 * The package shipping this family's `model.onnx`.
	 */
	graphPackage: string
	encoder: FamilyEncoder
	/**
	 * Every locale this family serves, including the graph package's own.
	 *
	 * A locale appears in exactly one family, which the `weights-family` repository
	 * check enforces against the installed `neural-weights-*` manifests.
	 */
	locales: readonly string[]
	/**
	 * Language subtags this family serves beyond the locales it packages.
	 *
	 * A family whose members are decided by writing system serves every locale
	 * in those languages, packaged or not.
	 * `ko-KR` ships no weights package and still decodes on the character graph,
	 * and so do `zh-TW` and `zh-HK`.
	 *
	 * Listing only the packaged locales made
	 * {@linkcode familyForLocale} answer `undefined` for all three while `scriptFamilyBase`
	 * answered `cjk`, which is the disagreement this field removes.
	 */
	languages?: readonly string[]
	/**
	 * Unicode script codes that route an input here.
	 *
	 * A family declaring none is reachable only through the caller's locale.
	 */
	routingScripts?: ReadonlySet<string>
	/**
	 * Locales that route here when a locale predicate is read.
	 *
	 * Declared for completeness of the contract and read by no shipping router.
	 * Enabling one changes which graph serves an existing request,
	 * and `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` requires a route comparison
	 * and a full regression board before that ships.
	 */
	routingLocales?: readonly string[]
}

/**
 * The Latin SentencePiece family.
 *
 * Eight overlays declare `mailwoman.baseWeights` on its graph package and ship retrieval artifacts only.
 *
 * It declares no routing predicate.
 * Every Latin request reaches it through the caller's locale, which is the behavior
 * that predates this registry and the behavior the registry preserves.
 */
const LATIN_FAMILY: WeightsFamily = {
	family: "en-us",
	graphPackage: "@mailwoman/neural-weights-en-us",
	encoder: FamilyEncoder.SentencePiece,
	locales: ["en-us", "en-gb", "en-au", "en-in", "en-nz", "de-de", "es-es", "fr-fr", "it-it"],
}

/**
 * The character family.
 *
 * Japanese, Chinese and Korean share one graph and one character vocabulary,
 * so the four scripts below name one family rather than three.
 */
const CJK_FAMILY: WeightsFamily = {
	family: "cjk",
	graphPackage: "@mailwoman/neural-weights-cjk",
	encoder: FamilyEncoder.Char,
	locales: ["cjk", "ja-jp", "zh-cn"],
	languages: ["ja", "zh", "ko"],
	routingScripts: new Set(["Hani", "Kana", "Hira", "Hang"]),
}

/**
 * Every declared family.
 *
 * A third entry arrives with a measured graph artifact, never ahead of one.
 */
export const FAMILIES: readonly WeightsFamily[] = [LATIN_FAMILY, CJK_FAMILY]

const FAMILY_BY_ID = new Map(FAMILIES.map((entry) => [entry.family, entry]))

const FAMILY_BY_LOCALE = new Map(FAMILIES.flatMap((entry) => entry.locales.map((locale) => [locale, entry] as const)))

/**
 * The family with this id, or `undefined`.
 */
export function familyByID(family: string): WeightsFamily | undefined {
	return FAMILY_BY_ID.get(family)
}

/**
 * The family serving this locale, or `undefined` when no family claims it.
 *
 * A packaged locale answers first.
 * A locale the registry does not package answers from its language subtag, so `ko-KR`
 * and `zh-TW` reach the character family without a weights package of their own.
 *
 * A locale absent from both is a locale with no declared graph.
 * That is a finding rather than a default — the `weights-family` check reports it —
 * so callers must not read `undefined` as the Latin family.
 */
export function familyForLocale(locale: string): WeightsFamily | undefined {
	const code = locale.toLowerCase()
	const packaged = FAMILY_BY_LOCALE.get(code)

	if (packaged) return packaged

	const language = code.split("-")[0]

	return FAMILIES.find((entry) => entry.languages?.includes(language as string))
}

/**
 * The family a locale falls back to when it packages no graph of its own, or `undefined`.
 *
 * Three cases answer `undefined`, and they are different.
 * A locale equal to a family id names the base itself, which falls back to nothing.
 *
 * A Latin overlay names its base through `mailwoman.baseWeights` in its manifest,
 * so resolution follows that rather than a script rule.
 * A locale no family claims has no graph at all.
 *
 * Kept as its own function rather than folded into {@linkcode familyForLocale} because the
 * two answer different questions: `familyForLocale("cjk")` is the character family, and
 * `familyFallbackFor("cjk")` is nothing, since the character family is where `cjk` already resolves.
 */
export function familyFallbackFor(locale: string): string | undefined {
	const code = locale.toLowerCase()
	const family = familyForLocale(code)

	if (!family || family.family === code) return undefined

	// A family with no routing predicate is reached through `mailwoman.baseWeights`,
	// which the package manifest declares.
	// Answering here as well would give resolution two sources for one fact.
	return family.routingScripts ? family.family : undefined
}

/**
 * Every script that routes to some family, across all families.
 */
export const FAMILY_SCRIPTS: ReadonlySet<string> = new Set(
	FAMILIES.flatMap((entry) => [...(entry.routingScripts ?? [])])
)

/**
 * The family a script routes to, or `undefined`.
 */
export function familyForScript(script: string): WeightsFamily | undefined {
	for (const entry of FAMILIES) {
		if (entry.routingScripts?.has(script)) return entry
	}

	return undefined
}

/**
 * Whether some comma segment of the input is written wholly in a script the given family serves.
 *
 * This is the reading that separates an address line in another script from a name in another script: `逊克二分场四队,
 * heilongjiang, china` carries its Han unit as its own segment, while the Han in `Far East Chinese 口福羊汤, 13 Gerrard St,
 * London W1D 5PS` shares its segment with the Latin words that introduce it, and the character model reading those
 * Latin words by codepoint answers `country: "Chi"`. Tokens carrying no script (`Zyyy` — a house number, a postal code)
 * abstain rather than disqualifying a segment, which is what keeps `六分场七队 100` a Han line. A share threshold is not the
 * instrument: the venue rows and the Chinese unit rows overlap in how much Han they carry, and differ only in where it
 * sits.
 *
 * A Han line separated from its Latin province by whitespace alone (`六分场七队 Hunan`)
 * has no segment of its own and is not routed.
 * Reading whitespace runs instead would reach it and would also re-admit the Han
 * venue names, so the comma is the boundary this rule reads.
 */
/**
 * Whether the input opens with a run of tokens written in a script the given family serves.
 *
 * A candidate predicate, measured and unshipped. {@linkcode routeFamilyForText} does not
 * read it, and enabling it would change which graph serves an existing request.
 * `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` requires a route comparison
 * and a full regression board before that ships.
 *
 * It exists because {@linkcode carriesFamilySegmentFor} reads comma segments, and four CN
 * board rows write their Han unit and their Latin province in one whitespace-separated run —
 * `六分场七队 Hunan` has no comma, so no segment is wholly Han and the row stays on the Latin graph.
 * Reading whitespace runs instead would reach those four and would also reach the venue rows the
 * segment rule exists to exclude, because `Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS`
 * carries a whitespace-bounded Han run too.
 *
 * Position separates them where extent does not.
 * In the four CN rows the Han leads the input.
 *
 * In the venue rows the Han follows Latin words or is glued to one.
 * So this reads the first token that carries a script at all and asks whether that script is the family's.
 *
 * Tokens carrying no script (`Zyyy` — a house number, a postal code) are skipped
 * rather than answering, which keeps `〒150-0001 Tokyo` from being decided by its postal mark.
 *
 * It reaches no input written wholly in Latin script, so the two romaji JP
 * board rows stay where they are under it.
 * A locale or postcode predicate is the only kind that reaches those.
 */
export function leadsWithFamilyScriptFor(
	shape: Pick<QueryShape, "tokenClasses">,
	scripts: ReadonlySet<string>
): boolean {
	for (const token of shape.tokenClasses) {
		if (token.script === "Zyyy") continue

		return scripts.has(token.script)
	}

	return false
}

export function carriesFamilySegmentFor(
	shape: Pick<QueryShape, "tokenClasses" | "segments">,
	scripts: ReadonlySet<string>
): boolean {
	for (const segment of shape.segments) {
		let scripted = 0

		for (const token of shape.tokenClasses) {
			if (token.span.start < segment.span.start || token.span.end > segment.span.end) continue

			if (token.script === "Zyyy") continue

			if (!scripts.has(token.script)) {
				scripted = 0

				break
			}

			scripted++
		}

		if (scripted > 0) return true
	}

	return false
}
