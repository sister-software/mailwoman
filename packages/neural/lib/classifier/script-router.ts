/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Routes each input to the primary classifier or to the weights family whose script the input uses.
 *
 *   The families and their routing scripts are declared in `#weights/families`. A family without routing scripts,
 *   such as the Latin family, is reachable only through the caller's locale. A family loads on first use. When its
 *   package is missing, the router warns once and falls back to the primary.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { scoreByPostcode, scoreByScript } from "@mailwoman/locale-hint"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

import { scriptFamilyBase } from "#char-encoder"
import type { NeuralAddressClassifier } from "#classifier/index"
import type { ParseOpts } from "#classifier/options"
import type { NeuralParseTrace } from "#trace"
import {
	carriesFamilySegmentFor,
	FAMILIES,
	familyForLocale,
	leadsWithFamilyScriptFor,
	type RoutingDecision,
	RouteSource,
} from "#weights/families"

/**
 * Returns the family that claims a comma segment of the input, or `undefined`.
 *
 * The `weights-family` repository check rejects a script claimed by two families,
 * so declaration order does not affect the result.
 */
function familyForSegment(shape: Pick<QueryShape, "tokenClasses" | "segments">): string | undefined {
	for (const entry of FAMILIES) {
		if (!entry.routingScripts) continue

		if (carriesFamilySegmentFor(shape, entry.routingScripts)) return entry.family
	}

	return undefined
}

/**
 * Returns whether some comma segment of the input is written entirely in a
 * script that a declared family routes.
 */
export function carriesFamilySegment(shape: Pick<QueryShape, "tokenClasses" | "segments">): boolean {
	return familyForSegment(shape) !== undefined
}

/**
 * Routes like {@linkcode routeFamilyForText}, then tries a leading run of a
 * family's script when that router abstains.
 *
 * This experimental router is used only for measurement by `route-census.run.ts`.
 * Because it runs only on an abstention, it can add routes and never changes an existing one.
 */
export function routeFamilyWithLeadingRun(text: string): RoutingDecision {
	const shipped = routeFamilyForText(text)

	if (shipped.family) return shipped

	const shape = computeQueryShape(text)

	for (const family of FAMILIES) {
		if (!family.routingScripts) continue

		if (leadsWithFamilyScriptFor(shape, family.routingScripts)) {
			return { family: family.family, source: RouteSource.Script, confidence: 1 }
		}
	}

	return shipped
}

/**
 * Routes like {@linkcode routeFamilyForText}, then tries the postcode format when that router abstains.
 *
 * This experimental router is used only for measurement.
 * It can route romanized Japanese, which has no non-Latin characters for a script rule to match.
 *
 * Of the unambiguous formats that `scoreByPostcode` recognizes, only `jp_postcode`
 * maps to a family with routing scripts.
 */
export function routeFamilyWithPostcode(text: string): RoutingDecision {
	const shipped = routeFamilyForText(text)

	if (shipped.family) return shipped

	const candidate = scoreByPostcode(computeQueryShape(text))

	if (!candidate || candidate.confidence < POSTCODE_ROUTE_CONFIDENCE) return shipped

	const family = familyForLocale(candidate.locale)

	// A family without routing scripts is reachable only through the caller's locale.
	if (!family?.routingScripts) return shipped

	return { family: family.family, source: RouteSource.Locale, confidence: candidate.confidence }
}

/**
 * The minimum postcode confidence that may select a family.
 *
 * `scoreByPostcode` returns 0.95 for an unambiguous format and 0.5 for the five-digit fallback.
 * This threshold admits only the unambiguous formats.
 */
const POSTCODE_ROUTE_CONFIDENCE = 0.9

/**
 * Returns the family this text routes to and the rule that selected it.
 *
 * The router first applies the locale hint's whole-input script rule, folded to a weights family.
 * It then checks for a comma segment written entirely in a family's script ({@link carriesFamilySegment}).
 *
 * The segment check matters for mixed input, such as a Han address line followed by a Latin province.
 * A decision without a family records why the router abstained.
 */
export function routeFamilyForText(text: string): RoutingDecision {
	const shape = computeQueryShape(text)
	const candidate = scoreByScript(shape)
	const hinted = candidate ? scriptFamilyBase(candidate.locale) : undefined

	if (hinted) return { family: hinted, source: RouteSource.Script, confidence: 1 }

	const segment = familyForSegment(shape)

	if (segment) return { family: segment, source: RouteSource.ScriptSegment, confidence: 1 }

	return {
		family: undefined,
		source: RouteSource.Caller,
		confidence: 1,
		abstainedBecause: "no declared family names a script this input is written in",
	}
}

/**
 * Returns the weights family this text routes to, or undefined when no family applies.
 *
 * {@linkcode routeFamilyForText} also returns the rule that selected the family.
 */
export function scriptFamilyForText(text: string): string | undefined {
	return routeFamilyForText(text).family
}

/**
 * The parse methods and weights metadata that the router needs from a classifier.
 */
export type RoutableClassifier = Pick<
	NeuralAddressClassifier,
	"encoder" | "parse" | "traceParse" | "fstPath" | "streetMorphologyPath" | "resolvedWeights" | "spanGrammar"
>

/**
 * Options for {@link ScriptRoutedClassifier}.
 */
export interface ScriptRoutedClassifierOpts<C extends RoutableClassifier = RoutableClassifier> {
	/**
	 * The classifier for the caller's locale, which handles every input that does not route to a family.
	 */
	primary: C
	/**
	 * Loads a family's classifier, such as `cjk`.
	 *
	 * The router calls it at most once per family.
	 * A rejection marks the family unavailable.
	 */
	loadFamily: (family: string) => Promise<C>
	/**
	 * Receives the error once for each family whose load failed.
	 */
	onFamilyUnavailable?: (family: string, error: unknown) => void
}

/**
 * Removes the FST options, which belong to the primary's weights package, from a routed parse.
 */
function withoutPrimaryArtifacts(opts: ParseOpts | undefined): ParseOpts | undefined {
	if (!opts) return opts

	const { fst: _fst, fstStreetMorphology: _morphology, fstStreetMorphologyOpts: _morphologyOpts, ...routed } = opts

	return routed
}

/**
 * A classifier that sends each input to the primary or to the weights family for the input's script.
 *
 * A primary that already uses the character encoder is never rerouted.
 */
export class ScriptRoutedClassifier<C extends RoutableClassifier = RoutableClassifier> {
	readonly primary: C
	readonly #loadFamily: ScriptRoutedClassifierOpts<C>["loadFamily"]
	readonly #onFamilyUnavailable: ScriptRoutedClassifierOpts<C>["onFamilyUnavailable"]
	readonly #families = new Map<string, Promise<C>>()
	readonly #unavailable = new Set<string>()

	constructor(opts: ScriptRoutedClassifierOpts<C>) {
		this.primary = opts.primary
		this.#loadFamily = opts.loadFamily
		this.#onFamilyUnavailable = opts.onFamilyUnavailable
	}

	/**
	 * The primary's encoder.
	 *
	 * Input normalization should read the encoder of the classifier from {@link forInput}, which may differ.
	 */
	get encoder(): RoutableClassifier["encoder"] {
		return this.primary.encoder
	}

	get fstPath(): RoutableClassifier["fstPath"] {
		return this.primary.fstPath
	}

	get streetMorphologyPath(): RoutableClassifier["streetMorphologyPath"] {
		return this.primary.streetMorphologyPath
	}

	get resolvedWeights(): RoutableClassifier["resolvedWeights"] {
		return this.primary.resolvedWeights
	}

	get spanGrammar(): RoutableClassifier["spanGrammar"] {
		return this.primary.spanGrammar
	}

	/**
	 * Returns the classifier for this text: the routed family's classifier
	 * when one applies and loads, else the primary.
	 */
	async forInput(text: string): Promise<C> {
		const family = scriptFamilyForText(text)

		if (!family || this.primary.encoder === "char" || this.#unavailable.has(family)) {
			return this.primary
		}

		let pending = this.#families.get(family)

		if (!pending) {
			pending = this.#loadFamily(family).catch((error: unknown) => {
				this.#unavailable.add(family)
				this.#families.delete(family)
				this.#onFamilyUnavailable?.(family, error)

				return this.primary
			})

			this.#families.set(family, pending)
		}

		return pending
	}

	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		const classifier = await this.forInput(text)

		return classifier.parse(text, classifier === this.primary ? opts : withoutPrimaryArtifacts(opts))
	}

	async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace> {
		const classifier = await this.forInput(text)

		return classifier.traceParse(text, classifier === this.primary ? opts : withoutPrimaryArtifacts(opts))
	}
}
