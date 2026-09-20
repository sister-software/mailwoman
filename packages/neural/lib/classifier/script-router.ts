/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The script-routed classifier: one primary model for the locale the caller asked for, and the character-path
 *   family for an input whose script the primary cannot read.
 *
 *   A process loads one classifier for its `--locale` and every input reaches it, so a Hangul or kanji line handed to
 *   the Latin model came back as a locality holding the whole string. Which families exist, which locales each one
 *   serves and which scripts route to one are declared in `#weights/families`. This module reads those predicates and
 *   supplies the classifier that acts on them.
 *
 *   The routing rule has two readings, either of which names a family. The first is the locale hint's own script rule
 *   (`scoreByScript`: the `cjk` character class answers `ja-JP`) folded to its weights family (`scriptFamilyBase`:
 *   `ja` / `zh` / `ko` → `cjk`), so the decision the hint reports and the model that runs agree by construction. The
 *   second is per segment: a comma segment written wholly in a script a family serves names it, whatever the rest of
 *   the input is written in (`carriesFamilySegment`). The whole-input fold cannot see that reading — it answers
 *   `mixed` for a Han address line beside a Latin province and for a Han venue name inside a Latin line alike, and
 *   only the first of those belongs on the character path. A primary that already reads characters (`--locale
 *   ja-JP`) is never re-routed: the caller named it.
 *
 *   A family declaring no routing predicate is reachable only through the caller's locale. The Latin family declares
 *   none, so a Latin request runs on the graph it reached before this registry existed.
 *
 *   The family loads once, on the first input that needs it, and a family whose package is absent degrades to the
 *   primary with one warning — the tolerate-and-degrade posture every optional artifact takes, because a consumer who
 *   installed only `neural-weights-en-us` must keep parsing Latin addresses.
 *
 *   The gazetteer priors (`fst`, `fstStreetMorphology`) belong to the primary's weights package and are dropped from a
 *   routed parse: a Latin FST over a kanji line matches nothing, and the family ships its own siblings.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { scoreByScript } from "@mailwoman/locale-hint"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

import { scriptFamilyBase } from "#char-encoder"
import type { NeuralAddressClassifier } from "#classifier/index"
import type { ParseOpts } from "#classifier/options"
import type { NeuralParseTrace } from "#trace"
import { carriesFamilySegmentFor, FAMILIES, type RoutingDecision, RouteSource } from "#weights/families"

/**
 * The family claiming a comma segment of this input, or `undefined`.
 *
 * Families are read in declaration order. Two families claiming the same script would make that order decide the
 * answer. The `weights-family` repository check refuses a script claimed twice, so the order changes nothing.
 */
function familyForSegment(shape: Pick<QueryShape, "tokenClasses" | "segments">): string | undefined {
	for (const entry of FAMILIES) {
		if (!entry.routingScripts) continue

		if (carriesFamilySegmentFor(shape, entry.routingScripts)) return entry.family
	}

	return undefined
}

/**
 * Whether some comma segment of the input is written wholly in a script some declared family serves.
 *
 * {@linkcode carriesFamilySegmentFor} decides one script set. This asks it once per declared family, which is the
 * question the router answers.
 */
export function carriesFamilySegment(shape: Pick<QueryShape, "tokenClasses" | "segments">): boolean {
	return familyForSegment(shape) !== undefined
}

/**
 * The family this text routes to, and the reading that named it.
 *
 * Two readings, tried in order, and either suffices: the locale hint's whole-input script rule, and a comma segment
 * written wholly in a script a family serves ({@link carriesFamilySegment}). A decision naming no family carries the
 * reason it abstained, which is what measuring a router needs — an abstention and a wrong route are different failures,
 * and the family alone cannot separate them.
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
 * The weights family this text routes to, or undefined when no reading names one (Latin, Cyrillic, Arabic today).
 *
 * The answer alone. {@linkcode routeFamilyForText} carries the reading that produced it.
 */
export function scriptFamilyForText(text: string): string | undefined {
	return routeFamilyForText(text).family
}

/**
 * What the router reads from a classifier: the parse entries and the weights-package metadata the session forwards. A
 * `NeuralAddressClassifier` satisfies it. so does a test stub.
 */
export type RoutableClassifier = Pick<
	NeuralAddressClassifier,
	"encoder" | "parse" | "traceParse" | "fstPath" | "streetMorphologyPath" | "resolvedWeights" | "spanGrammar"
>

export interface ScriptRoutedClassifierOpts<C extends RoutableClassifier = RoutableClassifier> {
	/**
	 * The classifier for the locale the caller asked for. Every input reaches it unless its script names a family.
	 */
	primary: C
	/**
	 * Load the family's classifier (`cjk`). Called once per family. a rejection marks the family unavailable.
	 */
	loadFamily: (family: string) => Promise<C>
	/**
	 * Told once per family whose load failed, with the cause, before the primary answers in its place.
	 */
	onFamilyUnavailable?: (family: string, error: unknown) => void
}

/**
 * The parse options minus the ones naming the primary package's own artifacts, withheld from a routed parse.
 */
function withoutPrimaryArtifacts(opts: ParseOpts | undefined): ParseOpts | undefined {
	if (!opts) return opts

	const { fst: _fst, fstStreetMorphology: _morphology, fstStreetMorphologyOpts: _morphologyOpts, ...routed } = opts

	return routed
}

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
	 * The primary's encoder. A per-input reading is {@link forInput}: the normalizer's postal-mark decision must follow
	 * the classifier that will run rather than the one the process was opened with.
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
	 * The classifier this text will run on: the family's when the text's script names one the primary cannot read, else
	 * the primary.
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
