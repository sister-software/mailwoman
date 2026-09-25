/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Declares the weights families: each model graph, the locales it serves and the scripts that route input to it.
 *
 *   A family is one model graph plus its vocabulary artifact. Other `neural-weights-*` packages are overlays that ship
 *   retrieval artifacts and inherit their graph through `mailwoman.baseWeights`. A family without routing scripts is
 *   reachable only through the caller's locale.
 */

import type { QueryShape } from "@mailwoman/query-shape"

/**
 * How a family's graph reads its input.
 *
 * `sentencepiece` reads subword ids from `tokenizer.model`.
 * `char` reads code points indexed by `char-vocab.json`.
 * The value matches the `encoder` field of a model card.
 */
export const FamilyEncoder = {
	SentencePiece: "sentencepiece",
	Char: "char",
} as const

/**
 * One {@link FamilyEncoder} value.
 */
export type FamilyEncoder = (typeof FamilyEncoder)[keyof typeof FamilyEncoder]

/**
 * The vocabulary file each encoder requires beside `model.onnx`.
 *
 * A family's graph package ships both files.
 * An overlay ships neither and resolves them from its base.
 */
export const FAMILY_VOCABULARY_ARTIFACT: Readonly<Record<FamilyEncoder, string>> = {
	[FamilyEncoder.SentencePiece]: "tokenizer.model",
	[FamilyEncoder.Char]: "char-vocab.json",
}

/**
 * The rule that produced a routing decision.
 */
export const RouteSource = {
	/**
	 * No rule matched, so the input runs on the caller's locale.
	 */
	Caller: "caller",
	/**
	 * The locale hint's whole-input script rule selected the family.
	 */
	Script: "script",
	/**
	 * A comma segment is written entirely in one of the family's scripts.
	 *
	 * This catches mixed input, such as a Han address line followed by a Latin province.
	 */
	ScriptSegment: "script-segment",
	/**
	 * A locale-based rule selected the family, such as the experimental postcode router.
	 */
	Locale: "locale",
} as const

/**
 * One {@link RouteSource} value.
 */
export type RouteSource = (typeof RouteSource)[keyof typeof RouteSource]

/**
 * A router's decision for one input and the rule behind it.
 *
 * The rule and abstention reason let a caller measure a router, which the family alone cannot support.
 */
export interface RoutingDecision {
	/**
	 * The family this input routes to, or `undefined` to stay on the caller's locale.
	 */
	family: string | undefined
	source: RouteSource
	/**
	 * How strongly the rule claims the input, in `[0, 1]`.
	 *
	 * The script rules always return `1` when they match.
	 */
	confidence: number
	/**
	 * Why the router selected no family.
	 * It is absent when `family` is set.
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
	 * It is also the locale segment that `resolveWeights` uses for the graph package,
	 * so `cjk` resolves `@mailwoman/neural-weights-cjk`.
	 */
	family: string
	/**
	 * The package that ships this family's `model.onnx`.
	 */
	graphPackage: string
	encoder: FamilyEncoder
	/**
	 * Every locale this family serves, including the graph package's own.
	 *
	 * The `weights-family` repository check requires each locale to appear in exactly one family.
	 */
	locales: readonly string[]
	/**
	 * Language subtags this family serves beyond its packaged locales.
	 *
	 * This lets {@linkcode familyForLocale} map unpackaged locales such as `ko-KR` and `zh-TW` to the family.
	 */
	languages?: readonly string[]
	/**
	 * Unicode script codes that route an input to this family.
	 *
	 * A family without routing scripts is reachable only through the caller's locale.
	 */
	routingScripts?: ReadonlySet<string>
	/**
	 * Locales that would route to this family under a locale-based rule.
	 *
	 * No shipped router reads it.
	 * `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` requires a route comparison
	 * and a full regression board before one does.
	 */
	routingLocales?: readonly string[]
}

/**
 * The Latin SentencePiece family.
 *
 * Its overlays declare `mailwoman.baseWeights` on its graph package and ship only retrieval artifacts.
 * It has no routing scripts, so Latin requests reach it through the caller's locale.
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
 * Japanese, Chinese and Korean share one graph and one character vocabulary.
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
 */
export const FAMILIES: readonly WeightsFamily[] = [LATIN_FAMILY, CJK_FAMILY]

const FAMILY_BY_ID = new Map(FAMILIES.map((entry) => [entry.family, entry]))

const FAMILY_BY_LOCALE = new Map(FAMILIES.flatMap((entry) => entry.locales.map((locale) => [locale, entry] as const)))

/**
 * Returns the family with this id, or `undefined`.
 */
export function familyByID(family: string): WeightsFamily | undefined {
	return FAMILY_BY_ID.get(family)
}

/**
 * Returns the family serving this locale, or `undefined` when no family claims it.
 *
 * A packaged locale matches first.
 * Otherwise the language subtag decides, so `ko-KR` and `zh-TW` reach the character family.
 * Callers must not treat `undefined` as the Latin family.
 */
export function familyForLocale(locale: string): WeightsFamily | undefined {
	const code = locale.toLowerCase()
	const packaged = FAMILY_BY_LOCALE.get(code)

	if (packaged) return packaged

	const language = code.split("-")[0]

	return FAMILIES.find((entry) => entry.languages?.includes(language as string))
}

/**
 * Returns the family id that a locale without its own graph falls back to, or `undefined`.
 *
 * It returns `undefined` for a family id itself, for a locale in a family without
 * routing scripts, and for a locale that no family claims.
 * A Latin overlay names its base through `mailwoman.baseWeights` in its manifest instead.
 */
export function familyFallbackFor(locale: string): string | undefined {
	const code = locale.toLowerCase()
	const family = familyForLocale(code)

	if (!family || family.family === code) return undefined

	// The package manifest's `mailwoman.baseWeights` is the only source for families without routing scripts.
	return family.routingScripts ? family.family : undefined
}

/**
 * Every script that routes to some family, across all families.
 */
export const FAMILY_SCRIPTS: ReadonlySet<string> = new Set(
	FAMILIES.flatMap((entry) => [...(entry.routingScripts ?? [])])
)

/**
 * Returns the family a script routes to, or `undefined`.
 */
export function familyForScript(script: string): WeightsFamily | undefined {
	for (const entry of FAMILIES) {
		if (entry.routingScripts?.has(script)) return entry
	}

	return undefined
}

/**
 * Returns whether the first token that has a script is written in one of the given scripts.
 *
 * This experimental rule is not used by {@linkcode routeFamilyForText}.
 * It catches a Han line followed by a Latin province without a comma, such as `六分场七队 Hunan`,
 * which {@linkcode carriesFamilySegmentFor} misses.
 *
 * A venue name such as `Far East Chinese 口福羊汤` starts with Latin words, so the rule leaves it alone.
 * Tokens without a script (`Zyyy`), such as numbers and postal marks, are skipped.
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

/**
 * Returns whether some comma segment of the input is written entirely in the given scripts.
 *
 * The rule separates an address line in another script from a name in that script.
 * In `逊克二分场四队, heilongjiang, china` the Han unit is its own segment.
 *
 * In `Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS` the Han shares a segment
 * with Latin words, so the input stays on the Latin graph.
 * Tokens without a script (`Zyyy`), such as house numbers, neither count nor disqualify a segment.
 */
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
