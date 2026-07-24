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

import {
	runPipeline,
	type PipelineOpts,
	type PipelineResult,
	type POIIntent,
	type POIIntentOutcome,
	type RuntimePipelineStages,
} from "@mailwoman/core/pipeline"
import { classifyKind as defaultClassifyKind, createKindClassifier } from "@mailwoman/kind-classifier"
import { detectLocale as defaultDetectLocale } from "@mailwoman/locale-gate"
import type { NeuralAddressClassifier, ParseOpts } from "@mailwoman/neural"
import { normalize } from "@mailwoman/normalize"
import { groupPhrases as defaultGroupPhrases } from "@mailwoman/phrase-grouper"
import { getPOICategory, requiresBuildLocalLayer, resolveOvertureCategories } from "@mailwoman/poi-taxonomy"
import { computeQueryShape } from "@mailwoman/query-shape"
import type { StreetLocalityEvidence } from "@mailwoman/resolver"

import { loadDefaultPlaceCountry } from "./default-placer.ts"
import { loadDefaultReverseGeocoder } from "./default-reverse-geocoder.ts"
import { loadDefaultStreetEvidence } from "./default-street-evidence.ts"
import { rerankByStreetEvidence } from "./kbest-street-rerank.ts"
import { createPOIExecutor, type POIAncestryEntry } from "./poi-executor.ts"
import { createPOIIntentStage, poiTaxonomyLookup } from "./poi-intent.ts"

/** Structural shape of a `WOFReverseGeocoder`'s sync core — just what {@link buildSyncReverseGeocode} calls. */
interface ReverseGeocoderLike {
	reverseGeocodeSync(
		latitude: number,
		longitude: number
	): { hierarchy: ReadonlyArray<{ id: number; name: string; placetype: string }> }
}

/**
 * Adapt a `WOFReverseGeocoder` into the synchronous `reverseGeocode` fn `createPOIExecutor` expects (see
 * `poi-executor.ts` — the executor's return type carries no `Promise`, so this can't `await` the async `reverseGeocode`
 * method; `reverseGeocodeSync` is its already-synchronous core). Deepest-first `hierarchy` maps straight onto the
 * compact ancestry triple, AS-IS (spec's design point 4). A throw (e.g. an out-of-range coordinate slipping past
 * upstream validation) degrades to `undefined` — one bad point never fails the whole search. An empty `hierarchy` (e.g.
 * a valid coordinate with no bbox candidates — open ocean) ALSO degrades to `undefined`, not `[]` — house
 * meaning-of-zero: `decorateAncestry` only adds the `ancestry` key when there's something to add, and an empty array is
 * truthy, so this has to collapse it here rather than let a length-0 array slip through as "present."
 */
function buildSyncReverseGeocode(
	geocoder: ReverseGeocoderLike
): (latitude: number, longitude: number) => ReadonlyArray<POIAncestryEntry> | undefined {
	return (latitude, longitude) => {
		try {
			const { hierarchy } = geocoder.reverseGeocodeSync(latitude, longitude)

			if (hierarchy.length === 0) return undefined

			return hierarchy.map((place) => ({ placetype: place.placetype, name: place.name, wofID: place.id }))
		} catch {
			return undefined
		}
	}
}

export interface CreateRuntimePipelineOpts {
	/** The Stage 3 classifier — typically a `NeuralAddressClassifier`. */
	classifier?: RuntimePipelineStages["classifier"]
	/** The Stage 6 resolver — typically a `WOFResolver` from `@mailwoman/resolver-wof-sqlite`. */
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
	 * #690: default for `PipelineOpts.normalizeCase` on every call — title-case detected all-caps ASCII input before the
	 * model (helps on all-caps registry/compliance data; detection-gated, mixed-case untouched). The classifier is
	 * **default-ON** since #895 (drift D2 settled), so leaving this unset runs it; set `false` here to pin the raw-case
	 * parse for every call. A per-call `runOpts.normalizeCase` overrides this.
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
	/**
	 * #727 phase-4c: the street-name evidence index behind the k-best name-evidence rerank — a positive-evidence-gated
	 * street-splice into the argmax tree (golden-safe: 0.000 golden regression, +16.9pp FR fragment street, measured
	 * 2026-07-18).
	 *
	 * - `undefined` (default) → **default-on**: when the classifier ships a span grammar (a v3+ span-head bundle), the
	 *   bundled FR index ({@link loadDefaultStreetEvidence}, `street-centroids-fr.db`) is lazy-loaded on the first call
	 *   and the Stage-3 classifier reranks the street. A pre-v3 (span-less) classifier, or a missing shard, → no-op
	 *   (byte-stable): the rerank can only ADD an atlas-confirmed street, never remove a model call.
	 * - A `StreetLocalityEvidence` → use it (a custom / multi-country index).
	 * - `false` → disabled (no rerank).
	 */
	streetEvidence?: StreetLocalityEvidence | false
	/**
	 * POI-query detection + intent extraction (spec §3.1, exotic-POI arc plans 2 + 4). **Default-ON since 2026-07-20**
	 * (promotion battery: 0/4,507 golden misroutes, 6/6 demo presets byte-identical — see
	 * `docs/articles/evals/2026-07-20-poi-promotion-battery.md` and the runtime-flag register). When active: the kind
	 * classifier gains the poi-taxonomy lexicon (`poi_query` kind), the poi-intent stage is wired, and the anchor
	 * remainder parses through this same pipeline with the poi stage OFF (recursion guard). An explicit `classifyKind`
	 * override wins over the poi-aware default.
	 *
	 * - `undefined` (default) — same as `true`: intent-only mode. The stage extracts the intent but never executes it
	 *   (today's Plan-2 behavior), EXCEPT the build-local abstain still fires (`requires_build_local_layer` needs no db —
	 *   see `poi-executor.ts`).
	 * - `true` — explicit intent-only mode, same as the default.
	 * - `{ poiDatabasePath }` — additionally executes: a `POILookup` is constructed lazily on the first pipeline call
	 *   (mirrors the {@link placeCountry} lazy-load pattern so this factory stays synchronous) and wired into the
	 *   executor, so a matched intent comes back with `results` attached (or an `anchor_required` abstain).
	 * - `false` — disabled: the pipeline is byte-identical to pre-flag builds.
	 */
	poiQueryKind?: boolean | { poiDatabasePath?: string }
}

/**
 * #727 phase-4c: wrap the Stage-3 classifier so its `parse` reranks the STREET on street-name evidence — but ONLY when
 * an evidence index is injected AND the classifier ships a span grammar (a v3+ span-head bundle). Otherwise the
 * original classifier passes through untouched (byte-stable). The wrapper preserves the `AddressClassifier` contract:
 * it returns exactly the reranked tree, which is the argmax tree with the street spliced in on atlas-confirmed
 * evidence, else the plain argmax tree — the pipeline's downstream stages (resolver, etc.) see a normal `AddressTree`.
 */
function wrapWithStreetEvidence(
	classifier: RuntimePipelineStages["classifier"],
	evidence: StreetLocalityEvidence | undefined
): RuntimePipelineStages["classifier"] {
	if (!classifier || !evidence) return classifier
	const grammar = (classifier as Partial<NeuralAddressClassifier>).spanGrammar

	if (!grammar) return classifier // pre-v3 (span-less) bundle → nothing to rerank
	const inner = classifier as NeuralAddressClassifier

	return {
		// `cOpts` is the core `ClassifierOpts`; `rerankByStreetEvidence` wants the neural `ParseOpts`. ClassifierOpts is a
		// structural subset EXCEPT `placetypePair`, which core types opaquely (`object | false`, no neural dep — #1278)
		// while ParseOpts types it as `PlacetypePairPriorOpts | false`; at runtime the passthrough value IS a valid
		// PlacetypePairPriorOpts, so the narrowing cast at this core→neural bridge is sound.
		parse: async (text, cOpts) =>
			(await rerankByStreetEvidence(inner, text, evidence, grammar, { parseOpts: cOpts as ParseOpts | undefined }))
				.tree,
	}
}

/**
 * Build a runtime pipeline pre-wired with the default normalize + queryShape implementations.
 *
 * Returns a function that takes raw input + per-call opts and runs the full pipeline.
 *
 * @example
 * 	Const pipeline = createRuntimePipeline({ classifier: await
 * 	NeuralAddressClassifier.loadFromWeights({ locale: "en-US" }), resolver:
 * 	createWOFResolver(backend), }) const result = await pipeline("350 5th Ave, New York, NY 10118", {
 * 	locale: "en-US" })
 */
export function createRuntimePipeline(
	opts: CreateRuntimePipelineOpts = {}
): (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult> {
	// #1177: default-ON since 2026-07-20 (promotion battery: 0/4,507 golden misroutes, 6/6 demo
	// presets byte-identical). `undefined` → `true` (intent-only mode); an explicit `false` still
	// disables; the object form (executes against a real poi.db) passes through unchanged. Follows
	// the same `?? true` factory-default merge pattern as `hardPlaceCountry` below.
	const poiQueryKindEffective = opts.poiQueryKind ?? true
	const stages: RuntimePipelineStages = {
		normalize,
		computeQueryShape,
		// Default kind classifier: rule-based from @mailwoman/kind-classifier. Caller can override.
		// POI arc (default-ON since 2026-07-20). The poi-aware classifier only exists when the flag
		// resolves truthy; an explicit classifyKind override always wins. The anchor re-parse runs THIS
		// pipeline minus the poi stage: same stages object, but runPipeline never takes the poi branch
		// because anchorStages.poiIntent is absent and anchorStages.classifyKind is the default.
		classifyKind:
			opts.classifyKind ??
			(poiQueryKindEffective ? createKindClassifier({ poiLexicon: poiTaxonomyLookup }) : defaultClassifyKind),
		// Default phrase grouper: rule-based from @mailwoman/phrase-grouper. Hard dep in v0.5.0 —
		// not an opt-in shim. The plan doc framed Stage 2.7 as backward-compatible-opt-in for the
		// v0.4.0 pipeline; we have no current users to migrate, so v0.5.0 ships it as a required
		// stage. Override only with a compatible alternative (e.g. v0.5.1's learned span proposer).
		groupPhrases: opts.groupPhrases ?? defaultGroupPhrases,
		// The #727 phase-4c rerank wrap is applied lazily on the first call (below): an explicitly-passed
		// evidence index wraps immediately in spirit, but the DEFAULT (auto-load the bundled FR index) is async.
		classifier: opts.streetEvidence ? wrapWithStreetEvidence(opts.classifier, opts.streetEvidence) : opts.classifier,
		fst: opts.fst,
		resolver: opts.resolver,
		// Coarse country router (#244) — DEFAULT-ON (#244 M2). A function override is wired here; the
		// `undefined` default is lazy-loaded on the first call (below) so the sync factory stays sync;
		// `false` disables it. A confident in-map guess feeds the resolver's anchorPosterior re-rank.
		placeCountry: typeof opts.placeCountry === "function" ? opts.placeCountry : undefined,
		// Default locale gate: rule-based from @mailwoman/locale-gate. Derives locale from
		// QueryShape character class (CJK→ja-JP, Cyrillic→ru-RU, Arabic→ar) + known-format
		// hits (us_zip→en-US, fr_postcode→fr-FR, uk_postcode→en-GB). Caller-hint wins when set.
		detectLocale: opts.detectLocale ?? defaultDetectLocale,
	}

	// Build-local abstain (`requires_build_local_layer`) needs no db, so the executor is wired in BOTH
	// `poiQueryKind` modes — the poi-taxonomy touch (the one lexicon-aware bit) happens ONLY here in the
	// wiring, never inside `poi-executor.ts` (it stays injectable/pure).
	const requiresBuildLocal = (categoryID: string): boolean => {
		const category = getPOICategory(categoryID)

		return category ? requiresBuildLocalLayer(category) : false
	}

	// `poiQueryKind` undefined/`true` → intent-only executor (lookup undefined, build-local abstain
	// still fires). `poiQueryKind: { poiDatabasePath }` → upgraded below, on the first call, once the
	// lookup resolves. Reassigned in place (not a fresh `createPOIIntentStage` deps object) so the
	// stage — wired once, synchronously, right below — always dispatches through the latest executor.
	let poiExecute: ((intent: POIIntent) => POIIntentOutcome) | undefined = poiQueryKindEffective
		? createPOIExecutor({ lookup: undefined, requiresBuildLocal, resolveOvertureCategories })
		: undefined

	if (poiQueryKindEffective) {
		stages.poiIntent = createPOIIntentStage({
			lookup: poiTaxonomyLookup,
			// Inline spread, evaluated at CALL time: the factory's lazy stages (placeCountry,
			// streetEvidence) mutate `stages` on first run, and this form always sees the final
			// wiring. classifyKind reverts to the default (no poi lexicon) and poiIntent is
			// stripped — the recursion guard.
			parseAnchor: (text, runOpts) =>
				runPipeline(text, { ...stages, classifyKind: defaultClassifyKind, poiIntent: undefined }, runOpts),
			// Indirection for the same reason as `parseAnchor`'s spread above: `poiExecute` may be
			// upgraded (undefined lookup → a real `POILookup`) on the first pipeline call, after this
			// stage object is already built.
			execute: (intent) => poiExecute!(intent),
		})
	}

	// Default-on lazy wiring: when the caller neither supplied a placeCountry fn nor disabled it
	// (`false`), load the bundled placer once on the first call and inject it. Done in the returned
	// (async) function so the factory itself stays synchronous.
	const autoPlaceCountry = opts.placeCountry === undefined
	let placeCountryResolved = !autoPlaceCountry

	// #727 phase-4c default-on: with no explicit `streetEvidence` (and not `false`), auto-load the bundled FR index once
	// on the first call — but ONLY if the classifier ships a span grammar (else there is no k-best to rerank). Resolved
	// lazily for the same reason placeCountry is: keep the factory synchronous. An explicitly-passed index already
	// wrapped the classifier above.
	let streetEvidenceResolved = opts.streetEvidence !== undefined

	// Object-form `poiQueryKind` additionally executes against a real `POILookup`. Resolved lazily
	// (like placeCountry/streetEvidence above) so the factory stays synchronous — opening a sqlite
	// handle is I/O. Boolean `true` (or an object with no `poiDatabasePath`) has nothing to resolve:
	// `poiExecute` stays the no-lookup executor built above.
	const poiDatabasePath = typeof opts.poiQueryKind === "object" ? opts.poiQueryKind.poiDatabasePath : undefined
	let poiLookupResolved = !poiDatabasePath

	return async (raw: string, runOpts?: PipelineOpts): Promise<PipelineResult> => {
		if (!placeCountryResolved) {
			placeCountryResolved = true
			const fn = await loadDefaultPlaceCountry()

			if (fn) {
				stages.placeCountry = fn
			}
		}

		if (!poiLookupResolved && poiDatabasePath) {
			poiLookupResolved = true

			try {
				const { POILookup } = await import("@mailwoman/resolver-wof-sqlite/poi-lookup")
				// Read-time WOF ancestry (poiQueryKind register row's second debt payment): lazily loaded
				// alongside the lookup, same lazy-loader shape as placeCountry/streetEvidence above. A
				// missing admin gazetteer (no `place_bbox` R*Tree on disk) degrades to `undefined` here —
				// results still execute, they just carry no `ancestry` key (graceful, same spirit as the
				// poi.db-missing catch below).
				const reverseGeocoder = await loadDefaultReverseGeocoder()

				poiExecute = createPOIExecutor({
					lookup: new POILookup({ databasePath: poiDatabasePath }),
					requiresBuildLocal,
					resolveOvertureCategories,
					reverseGeocode: reverseGeocoder ? buildSyncReverseGeocode(reverseGeocoder) : undefined,
				})
			} catch {
				// Missing/unreadable poi.db → degrade to the intent-only executor already wired above
				// (build-local abstain still works; everything else falls back to bare intent).
			}
		}

		if (!streetEvidenceResolved) {
			streetEvidenceResolved = true
			const grammar = (opts.classifier as Partial<NeuralAddressClassifier> | undefined)?.spanGrammar

			if (grammar) {
				const evidence = await loadDefaultStreetEvidence()

				if (evidence) {
					stages.classifier = wrapWithStreetEvidence(opts.classifier, evidence)
				}
			}
		}
		// Apply factory-level defaults (#690 normalizeCase, #743/#194 hardPlaceCountry); a per-call
		// runOpts value overrides each. hardPlaceCountry is DEFAULT-ON (#743, 2026-06-22): the coverage
		// safelist confines the hard filter to well-covered countries, so this is a pure win there and a
		// no-op (soft) for the rest. A caller passes `hardPlaceCountry: false` to opt back out entirely.
		const factoryHardPlaceCountry = opts.hardPlaceCountry ?? true
		let effectiveRunOpts = runOpts

		// Propagate the factory pin in BOTH directions (#895): the classifier is default-ON now, so an
		// explicit factory `false` must reach it — swallowing false would break the opt-out.
		if (opts.normalizeCase !== undefined && effectiveRunOpts?.normalizeCase === undefined) {
			effectiveRunOpts = { ...effectiveRunOpts, normalizeCase: opts.normalizeCase }
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
	FSTMatcherLike,
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
