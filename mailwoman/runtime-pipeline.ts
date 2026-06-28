/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convenience factory that wires the default runtime-pipeline stages together.
 *
 *   Consumers who want the full happy-path (normalize → QueryShape → classify → resolve) can call
 *   `createRuntimePipeline({ classifier, resolver })` and get a one-call entry point. All stages
 *   have production-ready defaults: normalize, QueryShape, locale-gate (rule-based v1), kind
 *   classifier (rule-based), phrase grouper (rule-based). Only the neural classifier and resolver
 *   need explicit injection.
 *
 *   See `docs/articles/plan/reference/STAGES.md` for the full contract.
 */

import { solutionToProposals, type AddressParser } from "@mailwoman/core/parser"
import {
	runPipeline,
	type PipelineOpts,
	type PipelineResult,
	type RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
import type { ClassificationProposal } from "@mailwoman/core/types"
import { classifyKind as defaultClassifyKind } from "@mailwoman/kind-classifier"
import { detectLocale as defaultDetectLocale } from "@mailwoman/locale-gate"
import { normalize } from "@mailwoman/normalize"
import { groupPhrases as defaultGroupPhrases } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"

import { loadDefaultPlaceCountry } from "./default-placer.js"
import { createAddressParser } from "./utils/parser.js"

export interface CreateRuntimePipelineOpts {
	/** The Stage 3 classifier — typically a `NeuralAddressClassifier`. */
	classifier?: RuntimePipelineStages["classifier"]
	/** The Stage 6 resolver — typically a `WofResolver` from `@mailwoman/resolver-wof-sqlite`. */
	resolver?: RuntimePipelineStages["resolver"]
	/**
	 * Pre-built FST gazetteer matcher. Produces additive emission biases during neural classification.
	 */
	fst?: RuntimePipelineStages["fst"]
	/**
	 * Locale gate override — when shipped, replaces the default caller-trust stub.
	 *
	 * @see RuntimePipelineStages.detectLocale
	 */
	detectLocale?: RuntimePipelineStages["detectLocale"]
	/**
	 * Kind classifier override — when shipped, replaces the default no-fast-path stub.
	 *
	 * @see RuntimePipelineStages.classifyKind
	 */
	classifyKind?: RuntimePipelineStages["classifyKind"]
	/**
	 * Phrase grouper override (Stage 2.7). Defaults to the rule-based `@mailwoman/phrase-grouper`. v0.5.0 wires this in
	 * as a required stage; callers should normally NOT override unless they have a learned span proposer (planned for
	 * v0.5.1).
	 *
	 * @see RuntimePipelineStages.groupPhrases
	 */
	groupPhrases?: RuntimePipelineStages["groupPhrases"]
	/**
	 * Coarse country router (#244, soft prior) — **default-on (#244 M2, after the misroute gate).** A confident in-map
	 * guess becomes a soft country prior the resolver re-rank boosts (never filters).
	 *
	 * - `undefined` (default) → the bundled placer ({@link loadDefaultPlaceCountry}, open-set @ 0.9) is lazy-loaded on the
	 *   first pipeline call and applied (no prior if the model can't be resolved).
	 * - A function → use it (a custom placer / threshold).
	 * - `false` → disabled (no prior; byte-stable pre-M2 behavior).
	 *
	 * @see RuntimePipelineStages.placeCountry
	 */
	placeCountry?: RuntimePipelineStages["placeCountry"] | false
	/**
	 * The "rule source" for per-component arbitration (#478 increment 3). Defaults to a lazily-built v0
	 * `createAddressParser` whose solved output is projected to proposals via `solutionToProposals` — constructed on the
	 * first `arbitrate: true` call and never if arbitration is never used. Override to inject a custom rule parser or a
	 * fake in tests.
	 *
	 * @see RuntimePipelineStages.ruleProposer
	 */
	ruleProposer?: RuntimePipelineStages["ruleProposer"]
	/**
	 * #690: default for `PipelineOpts.normalizeCase` on every call — title-case detected all-caps ASCII input before the
	 * model (helps on all-caps registry/compliance data; detection-gated, mixed-case untouched). Off by default. A
	 * per-call `runOpts.normalizeCase` overrides this.
	 */
	normalizeCase?: boolean
	/**
	 * #743/#194: default for `PipelineOpts.hardPlaceCountry` on every call — promote a CONFIDENT coarse-placer guess from
	 * the soft prior to a HARD country filter (empty→unresolved). **DEFAULT-ON** (#743, 2026-06-22): the built-in
	 * coverage safelist (`HARD_PLACE_COUNTRY_SAFELIST`) confines the hard filter to well-covered countries
	 * (US/ES/IT/NL/DE/FR), so it's a pure win there and a no-op (soft prior) for the low-coverage tail (FI/PL) — no
	 * recall regression. Pass `false` to opt out entirely; a per-call `runOpts.hardPlaceCountry` overrides this.
	 */
	hardPlaceCountry?: boolean
	/**
	 * #743/#194: default for `PipelineOpts.hardCountrySafelist` — override the coverage safelist that gates the hard
	 * country filter. Undefined → the built-in `HARD_PLACE_COUNTRY_SAFELIST`. Used by the resolver eval to measure
	 * ungated hard-resolve-rates (the full in-map set) when growing the list.
	 */
	hardCountrySafelist?: ReadonlySet<string>
}

/**
 * Build a runtime pipeline pre-wired with the default normalize + queryShape implementations.
 *
 * Returns a function that takes raw input + per-call opts and runs the full pipeline.
 *
 * @example
 * 	Const pipeline = createRuntimePipeline({ classifier: await
 * 	NeuralAddressClassifier.loadFromWeights({ locale: "en-US" }), resolver:
 * 	createWofResolver(backend), }) const result = await pipeline("350 5th Ave, New York, NY 10118", {
 * 	locale: "en-US" })
 */
export function createRuntimePipeline(
	opts: CreateRuntimePipelineOpts = {}
): (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult> {
	// Lazy v0 rule parser for arbitration (#478 inc 3). Built on first use (only when a caller passes
	// `arbitrate: true`), so non-arbitrating pipelines pay nothing. The solved v0 output — not raw
	// classifier firings — is the coherent "rule" source projected to proposals.
	let v0Parser: AddressParser | undefined
	const defaultRuleProposer = async (normalizedText: string, locale: string): Promise<ClassificationProposal[]> => {
		v0Parser ??= createAddressParser()
		const solutions = await v0Parser.parse(normalizedText, { locale })
		const top = solutions[0]

		return top ? solutionToProposals(top, "v0-rules") : []
	}

	const stages: RuntimePipelineStages = {
		normalize,
		computeQueryShape,
		// Default kind classifier: rule-based from @mailwoman/kind-classifier. Caller can override.
		classifyKind: opts.classifyKind ?? defaultClassifyKind,
		// Default phrase grouper: rule-based from @mailwoman/phrase-grouper. Hard dep in v0.5.0 —
		// not an opt-in shim. The plan doc framed Stage 2.7 as backward-compatible-opt-in for the
		// v0.4.0 pipeline; we have no current users to migrate, so v0.5.0 ships it as a required
		// stage. Override only with a compatible alternative (e.g. v0.5.1's learned span proposer).
		groupPhrases: opts.groupPhrases ?? defaultGroupPhrases,
		classifier: opts.classifier,
		fst: opts.fst,
		resolver: opts.resolver,
		// Coarse country router (#244) — DEFAULT-ON (#244 M2). A function override is wired here; the
		// `undefined` default is lazy-loaded on the first call (below) so the sync factory stays sync;
		// `false` disables it. A confident in-map guess feeds the resolver's anchorPosterior re-rank.
		placeCountry: typeof opts.placeCountry === "function" ? opts.placeCountry : undefined,
		// Rule source for arbitration (#478 inc 3) — the lazy v0 parser above, override-able. Invoked
		// only when a call passes `arbitrate: true`; otherwise never built.
		ruleProposer: opts.ruleProposer ?? defaultRuleProposer,
		// Default locale gate: rule-based from @mailwoman/locale-gate. Derives locale from
		// QueryShape character class (CJK→ja-JP, Cyrillic→ru-RU, Arabic→ar) + known-format
		// hits (us_zip→en-US, fr_postcode→fr-FR, uk_postcode→en-GB). Caller-hint wins when set.
		detectLocale: opts.detectLocale ?? defaultDetectLocale,
	}

	// Default-on lazy wiring: when the caller neither supplied a placeCountry fn nor disabled it
	// (`false`), load the bundled placer once on the first call and inject it. Done in the returned
	// (async) function so the factory itself stays synchronous.
	const autoPlaceCountry = opts.placeCountry === undefined
	let placeCountryResolved = !autoPlaceCountry

	return async (raw: string, runOpts?: PipelineOpts): Promise<PipelineResult> => {
		if (!placeCountryResolved) {
			placeCountryResolved = true
			const fn = await loadDefaultPlaceCountry()

			if (fn) stages.placeCountry = fn
		}
		// Apply factory-level defaults (#690 normalizeCase, #743/#194 hardPlaceCountry); a per-call
		// runOpts value overrides each. hardPlaceCountry is DEFAULT-ON (#743, 2026-06-22): the coverage
		// safelist confines the hard filter to well-covered countries, so this is a pure win there and a
		// no-op (soft) for the rest. A caller passes `hardPlaceCountry: false` to opt back out entirely.
		const factoryHardPlaceCountry = opts.hardPlaceCountry ?? true
		let effectiveRunOpts = runOpts

		if (opts.normalizeCase && effectiveRunOpts?.normalizeCase === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, normalizeCase: true }
		}

		if (factoryHardPlaceCountry && effectiveRunOpts?.hardPlaceCountry === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, hardPlaceCountry: true }
		}

		if (opts.hardCountrySafelist && effectiveRunOpts?.hardCountrySafelist === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, hardCountrySafelist: opts.hardCountrySafelist }
		}

		return runPipeline(raw, stages, effectiveRunOpts)
	}
}

// Re-export the types so consumers don't need to import from both `mailwoman` and `@mailwoman/core/pipeline`.
// `ParseOpts` lives in `@mailwoman/neural` — re-export here so callers can type-check parse options
// without reaching into internal workspace packages.
export type {
	AddressClassifier,
	ClassifierOpts,
	FstMatcherLike,
	LocaleHint,
	NormalizedInputLite,
	PhraseGrouper,
	PhraseKind,
	PhraseProposal,
	PipelineOpts,
	PipelineResult,
	PipelineTiming,
	QueryKind,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
export type { ParseOpts } from "@mailwoman/neural"
