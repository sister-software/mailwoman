/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the runtime pipeline coordinator (`runPipeline`).
 *
 *   Generic over its stage implementations — each stage is an injected function or class, defined
 *   structurally. Keeps `@mailwoman/core` free of dependencies on the concrete neural / normalize /
 *   query-shape / resolver packages while still composing them at runtime when callers wire them
 *   up.
 *
 *   See `docs/engineering/reference/STAGES.md` for the full contract this implements.
 */

import type { AddressTree } from "#decoder/types"
import type { ResolveOpts, Resolver, ResolverBackend } from "#resolver/types"
import type { Section } from "#types/classifier"

export type LocaleTag = string

/**
 * Independent host/browser preferences. A timezone is evidence, never a locale conversion.
 */
export interface MachinePreferences {
	locale?: LocaleTag
	timeZone?: string
}

/**
 * Optional user-location signal for Stage 6 resolver scoring.
 */
export type UserLocation = { lat: number; lon: number } | { country: string } | { region: string; country: string }

/**
 * Opaque placetype-pair prior handle (placetype-pair-prior arc, #1278). `@mailwoman/core` carries no neural dependency,
 * so this is a PURE PASSTHROUGH: core never constructs or inspects it — it threads the value verbatim from
 * {@link PipelineOpts.placetypePair} into {@link ClassifierOpts.placetypePair}, and on into the neural classifier's
 * `parse` opts, where it is typed concretely (`PlacetypePairPriorOpts | false`). The browser demo produces it via
 * `neural-web`'s `LoadResult.selectPairIndexForText`. `undefined` (the default) is the byte-stable no-prior decode.
 */
export type PlacetypePairPassthrough = object | false

/**
 * Common opts threaded through every stage.
 */
export interface PipelineOpts {
	locale?: LocaleTag
	userLocation?: UserLocation
	/**
	 * Explicit input register (operator Decision A / GTM B10 — see {@link InputMode}). When unset the pipeline derives it
	 * from the kind classifier's verdict via {@link deriveInputMode}. Endpoint wrappers set their register default here
	 * (validation/batch → `"formatted"`, autocomplete/demo search → `"fragmented"`).
	 */
	inputMode?: InputMode
	/**
	 * Disable fast-path shortcuts; always run the full pipeline. Does NOT bypass the poi_query branch — that's a routing
	 * decision (the kind classifier + `stages.poiIntent`), not a fast-path shortcut, so a `poi_query`-classified input
	 * still takes the poi branch regardless of this flag.
	 */
	forceFullPipeline?: boolean
	/**
	 * Hard cap on lookups the resolver may issue; passed through.
	 */
	resolveOpts?: ResolveOpts
	/**
	 * #690: title-case detected all-caps ASCII input before the Stage 3 classifier (helps on all-caps registry/compliance
	 * data). Threaded to `ClassifierOpts.normalizeCase`. Detection-restricted
	 *
	 * - **Default-ON** (#895 settled drift D2; the classifier applies it when unset) — byte-stable for mixed-case input
	 *   either way. Pass `false` to restore the raw-case parse.
	 */
	normalizeCase?: boolean
	/**
	 * Placetype-pair prior (placetype-pair-prior arc, #1278) — an opaque, per-parse decode-channel handle threaded
	 * verbatim to `ClassifierOpts.placetypePair` (and on to the neural classifier's `parse`). The browser demo derives it
	 * per input via `neural-web`'s `LoadResult.selectPairIndexForText` (locale-gate over the text shape) so a GB/NZ input
	 * gets its dependent_locality-resurrecting prior while a US/FR input stays byte-stable. `undefined` (default) = no
	 * prior. See {@link PlacetypePairPassthrough}.
	 */
	placetypePair?: PlacetypePairPassthrough
	/**
	 * #743/#194: promote a CONFIDENT coarse-placer guess from the soft `anchorPosterior` boost to a HARD country filter
	 * (empty→unresolved) — see {@link ResolveOpts.hardCountry}. Gated three ways: the placer's confidence ≥
	 * `HARD_PLACE_COUNTRY_MIN_CONF` (ambiguous DK↔NO stay soft), the country is in the coverage
	 * `HARD_PLACE_COUNTRY_SAFELIST` (or a {@link hardCountrySafelist} override), and no caller
	 * `hardCountry`/`defaultCountry` is already set. **Default-ON** in the shipped
	 * `createRuntimePipeline`/`geocodeAddress` (#743, 2026-06-22) — but the safelist confines the hard filter to
	 * well-covered countries, so the low-coverage tail (FI/PL) keeps its recall on the soft path with no regression. Pass
	 * `false` to force the pre-#194 soft-only behavior.
	 */
	hardPlaceCountry?: boolean
	/**
	 * #743/#194: override the coverage safelist that gates {@link hardPlaceCountry}. Undefined → the loaded gazetteer
	 * artifact's own coverage manifest (`resolver.artifactCoverage.hardCountrySafelist`) when it carries one, else the
	 * built-in `HARD_PLACE_COUNTRY_SAFELIST` fallback (byte-identical for artifacts predating the manifest). Supply a set
	 * to test/measure a different coverage frontier — the resolver eval passes the full in-map country set to measure
	 * unrestricted hard-resolve-rates (which is how the production safelist is grown).
	 */
	hardCountrySafelist?: ReadonlySet<string>
	signal?: AbortSignal
}

/**
 * Minimal structural shape `NormalizedInput` must satisfy. Compatible with @mailwoman/normalize.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Minimal structural shape `QueryShape` must satisfy. Compatible with @mailwoman/query-shape.
 */
export interface QueryShapeLite {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	segments?: ReadonlyArray<{ body: string; index: number }>
	characterClass?: string
	totalLength?: number
}

/**
 * Detected (or asserted) locale + alternatives.
 */
export interface LocaleHint {
	locale: LocaleTag
	confidence: number
	alternatives: ReadonlyArray<{ locale: LocaleTag; confidence: number }>
	source: "caller" | "environment" | "machine" | "detected" | "ensemble"
	/**
	 * Diagnostic provenance for inferred preferences. Locale and timezone remain independent signals.
	 */
	evidence?: {
		intlLocale?: string
		timeZone?: string
		environmentLocale?: string
	}
}

/**
 * Kind classifier output.
 */
export type QueryKind =
	| "postcode_only"
	| "locality_only"
	| "structured_address"
	| "intersection"
	| "po_box"
	| "landmark"
	| "poi_query"
	| "vague"
	/**
	 * ROAD_TO_V9 §4 — the query-INTENT vocabulary. Four kinds that describe what the user is ASKING FOR rather than what
	 * their string is shaped like. They are ordinary members of this union (intent is vocabulary of the existing Stage
	 * 2.5, never a new stage), and each one, when it fires, attaches a {@link QueryIntentMarker} to the result.
	 *
	 * Two of the four are deliberately RANKED BELOW their structural incumbent and therefore surface in
	 * {@link QueryKindResult.alternatives} rather than as the top kind — see the individual docstrings in
	 * `@mailwoman/kind-classifier`'s `intent-rules.ts`. That is the D-rule discharge: the top kind is the only thing the
	 * coordinator routes on (`deriveInputMode`, `canShortCircuit`, the POI branch), so leaving it untouched is what makes
	 * the addition provably answer-neutral on the populations those incumbents already own.
	 */
	/**
	 * A single coherent place-name carrying no address grammar — no house number, no postcode, no street-type word. A
	 * strict REFINEMENT of `locality_only` (which also admits an admin tail: `Paris, FR`), scored just below it so the
	 * top kind never moves. Feeds the declared-ambiguity path: a bare toponym whose resolved candidates are not DECISIVE
	 * gets a `declared_ambiguity` marker at geocode time.
	 */
	| "bare_toponym"
	/**
	 * Two coherent toponyms with no address grammar between them — `Paris London`. Classification plus a DECLARED FORK,
	 * never a router (ROAD_TO_V9 §4.3): structure alone cannot separate a route pair from a comma-free locality+region
	 * fragment (`Moscow Idaho`), so both interpretations are named in the marker and neither wins.
	 */
	| "route_pair"
	/**
	 * Preposition/deictic locator with no anchor — `gas station near me`, `restaurants nearby`. The query names a
	 * category and a relation to the ASKER, and the asker's position is not in the string. Classification only in v9: the
	 * marker states that a focus point is required and absent.
	 */
	| "near_me"
	/**
	 * A bare POI category with nowhere to search — `tacos`, `grocery store`. The anchorless subset of `poi_query`,
	 * carrying the resolved `@mailwoman/poi-taxonomy` category id on its marker. Routes exactly as `poi_query` does (the
	 * coordinator's POI branch accepts both); resolution against `poi.db` is out of scope.
	 */
	| "poi_category"

/**
 * The advisory codes an intent kind can raise. Named per the suggestion-layer plan's rules
 * (`docs/superpowers/plans/2026-08-05-suggestion-layer.md` § Naming): never `*Coherence` (that vocabulary belongs to
 * the passes that decide what the answer IS), and never `correction`/`validation`. This surface only ever REPORTS.
 */
export const QueryIntentCode = {
	/**
	 * The query named a place, and the gazetteer's answer for that name is not decisive. Raised at RESOLVE time (the
	 * margin is a property of the candidate list, not of the string), so the classifier never emits it.
	 */
	DeclaredAmbiguity: "declared_ambiguity",
	/**
	 * The query admits two whole readings and the pipeline is not choosing between them. `evidence.interpretations` names
	 * both.
	 */
	DeclaredFork: "declared_fork",
	/**
	 * The query is relative to the asker and no focus point was supplied. `evidence.parameter` names the parameter that
	 * would carry one.
	 */
	FocusPointRequired: "focus_point_required",
	/**
	 * The query resolved to a POI taxonomy category. `evidence.categoryID` carries it.
	 */
	POICategory: "poi_category",
	/**
	 * The answer holds nothing of the asked-for kind, and a coverage layer surveyed the searched cell for exactly that
	 * kind — so the emptiness is a statement about the world rather than about retrieval. `evidence.coverage` carries the
	 * cell, its basis and the layer that measured it; without exclusion-grade coverage this code is never raised, because
	 * an unsurveyed cell is unknown and never absence.
	 */
	CoverageQualifiedAbsence: "coverage_qualified_absence",
	/**
	 * An authority publishes a designation for the resolved coordinate, and this is it — the code in that authority's own
	 * vocabulary, with the product and vintage it was read from and the coverage record stating that the authority made a
	 * determination there. `evidence.layer` names the artifact; `evidence.coverage` carries the cell and its basis.
	 *
	 * The code is raised at RESOLVE time and names the verdict's own top kind rather than a kind of its own: the marker
	 * is about the coordinate an answer reached, not about how the query was read, so there is no intent kind to name. A
	 * reading the authority does not make raises NOTHING — outside its footprint there is no coverage row, and an
	 * advisory there would report a determination nobody made.
	 */
	AuthorityDesignation: "authority_designation",
} as const

export type QueryIntentCode = (typeof QueryIntentCode)[keyof typeof QueryIntentCode]

/**
 * One advisory the intent vocabulary raised about a query.
 *
 * Shaped after {@link PipelineFault} on purpose, and for the same reason: the caller needs to tell "the pipeline
 * considered this and had something to say" apart from "the pipeline said nothing". A marker NEVER changes which answer
 * wins — it is additive, attributed, and always accompanied by the ordinary result. `mechanism` follows the
 * `family:rule` convention `PhraseProposal.source` established (`core/pipeline/span-proposer.ts`), so every marker
 * names the rule that produced it rather than asserting itself.
 */
export interface QueryIntentMarker {
	/**
	 * The intent kind that raised this marker. Present in {@link QueryKindResult} as either the top `kind` or an entry in
	 * `alternatives` — a marker whose kind appears in neither is a bug in the producer.
	 */
	kind: QueryKind
	code: QueryIntentCode
	/**
	 * `family:rule` — `kind:bare_toponym`, `kind:route_pair`, `resolver:dominance_margin`. Never `"unknown"`.
	 */
	mechanism: string
	/**
	 * Human-readable, for a surface that shows it. Not machine-stable; branch on `code`.
	 */
	message: string
	/**
	 * The measurement behind the marker, so it is auditable rather than assertive. Absent when the rule that fired had
	 * nothing to measure (meaning-of-zero: absent, never an empty object).
	 */
	evidence?: Record<string, unknown>
}

export interface QueryKindResult {
	kind: QueryKind
	confidence: number
	alternatives: ReadonlyArray<{ kind: QueryKind; confidence: number }>
	/**
	 * Advisories raised by the intent vocabulary (ROAD_TO_V9 §4). Optional on this interface — a pre-intent classifier
	 * (including `runtime-pipeline.ts`'s built-in default) simply doesn't set it — but `PipelineResult.intentMarkers` is
	 * always an array, so a consumer reading the RESULT never has to distinguish "absent" from "empty".
	 */
	intentMarkers?: ReadonlyArray<QueryIntentMarker>
}

/**
 * The input register (operator Decision A, 2026-07-28 — the Option-A evidence-bundle verdict): `fragmented` is the
 * map-search register (a human typing "belleville" or "12 rue de la paix"); `formatted` is the validation/record
 * register (a checkout form or CRM row submitting a full postal address). The evidence-bundle channels feed ONLY in
 * fragmented mode — three training runs showed they lift the fragment register (admin-street homonym +0.765 lower+heal)
 * while degrading full-address parses (the flip census, `.superpowers/sdd/progress.md` 2026-07-28). Explicitly settable
 * on every surface (CLI/API); when unset, {@link deriveInputMode} maps the kind-classifier's verdict. Endpoint defaults
 * (GTM B10): validation/batch/CSV → formatted; autocomplete/demo search → fragmented; plain parse → derived.
 */
export type InputMode = "fragmented" | "formatted"

/**
 * Map a {@link QueryKind} to its {@link InputMode} register. Multi-component postal specifications
 * (`structured_address`/`po_box`/`intersection`) are the formatted register; single-thing lookups (postcode, locality,
 * landmark, POI, vague) are fragments. NEVER keyed on case — lowercase is the primary user register (operator
 * doctrine).
 *
 * The four ROAD_TO_V9 §4 intent kinds are all fragments and all reach the register through the `default` arm, which is
 * why adding them changed no case in this switch: a bare toponym, a route pair, a `near me` and a bare POI category are
 * each a person typing one thing into a search box, never a form submitting a postal record.
 */
export function deriveInputMode(kind: QueryKind): InputMode {
	switch (kind) {
		case "structured_address":
		case "po_box":
		case "intersection":
			return "formatted"
		default:
			return "fragmented"
	}
}

/**
 * The structured POI intent — the pluggable boundary between detection (kind classifier), the executors (Plan 3's
 * poi.db SQL compiler), and the export formats (OverpassQL emitter). Category ids are `@mailwoman/poi-taxonomy` ids
 * carried as plain strings — core stays lexicon-free; the branded type lives with the data package. Spec §3.2:
 * docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md
 */
export interface POIIntent {
	subject:
		| {
				kind: "category"
				/**
				 * Every category the subject reaches. One id unless the subject lookup returned a set to be searched together —
				 * an activity afforded by several establishment kinds reaches one id per kind — in which case the executor
				 * searches the union and the candidate ordering decides the answer. The order is the lookup's enumeration and
				 * states NO preference: nothing may read position as rank.
				 */
				categoryIDs: string[]
				matched: string
		  }
		| { kind: "brand"; name: string; wikidata?: string; matched: string }
		| { kind: "name"; text: string }
	/**
	 * The relation crossing from the recognized subject span to the anchor span.
	 */
	relation?: "comma" | "near" | "in" | "at" | "around" | "to"
	/**
	 * Spatial anchor: the split-off remainder text and its parse, when the query carried one.
	 */
	anchor?: {
		text?: string
		tree?: AddressTree
		/**
		 * Caller-supplied bias point ("near me"); executors treat it as the anchor when no tree resolved.
		 */
		biasPoint?: { latitude: number; longitude: number }
		radiusM?: number
	}
	limit?: number
}

/**
 * One executed POI search result (spec §3.4; produced by the executor, absent pre-execution).
 */
export interface POIResult {
	name: string | null
	categoryID: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	/**
	 * Overture GERS id — nullable METADATA ONLY, never a key (the #470 rule).
	 */
	gersID: string | null
	/**
	 * Read-time WOF ancestry, deepest-first — the paid-down half of the poiQueryKind register row's debt. Attached by the
	 * executor ONLY when a reverse geocoder was wired (`runtime-pipeline.ts`'s lazy `WOFReverseGeocoder`); house
	 * meaning-of-zero style — ABSENT (the key is omitted), never an empty array or `undefined`-valued, when no reverse
	 * geocoder is available.
	 */
	ancestry?: ReadonlyArray<{ placetype: string; name: string; wofID: number }>
	distanceM?: number
}

/**
 * Outcome of the poi-intent stage. `abstain` = the query is POI-shaped but unanswerable as asked (e.g. no executor
 * wired for a build-local-only category) — surfaces map it to their native empty-result envelope instead of a mangled
 * parse.
 */
export type POIIntentOutcome =
	| { type: "intent"; intent: POIIntent; results?: POIResult[] }
	| { type: "abstain"; reason: string }

/**
 * Stage 2.7 phrase grouper output. Coarse phrase-shape hypothesis attached to a `Section` (sub-Span of the tokenized
 * input). The classifier (Stage 3) conditions on these proposals so it can answer the simpler "what type is this
 * proposed span?" instead of jointly discovering boundaries and types. The reconciler (Stage 5) consumes them as
 * boundary candidates for joint decoding.
 *
 * Taxonomy is purely structural — no place-name knowledge. A `LOCALITY_PHRASE` proposal is "this looks shaped like a
 * multi-word capitalized phrase that could be a city name" — not "this IS New York." Typing the span is the
 * classifier's job.
 *
 * See `docs/articles/concepts/the-knowledge-ladder.md` § Phrase grouper for the design rationale.
 */
export type PhraseKind =
	| "NUMERIC"
	| "STREET_PHRASE"
	| "LOCALITY_PHRASE"
	| "REGION_ABBREVIATION"
	| "POSTCODE"
	| "VENUE_PHRASE"
	| "HYPHENATED_COMPOUND"

/**
 * One phrase proposal emitted by Stage 2.7. The contract:
 *
 * - `span`: the input slice (sub-Span of the tokenized input) the proposal applies to.
 * - `kindHypothesis`: structural shape this slice looks like.
 * - `confidence`: 0..1 score. Used by downstream stages to weight proposals.
 *
 * Per "possibilities not constraints", emit a proposal whenever a rule fires — overlapping proposals over the same
 * tokens are expected (e.g. `Saint Petersburg` may surface as one `LOCALITY_PHRASE` AND two `LOCALITY_PHRASE`s, with
 * confidence ordering signalling which the grouper prefers).
 */
export interface PhraseProposal {
	span: Section
	kindHypothesis: PhraseKind
	confidence: number
}

/**
 * Stage 2.7 contract. Structural — any of the rule-based grouper (`@mailwoman/phrase-grouper`), a learned span proposer
 * (future), or a fake for tests satisfies this. Async so the coordinator can stay uniform even when implementations
 * call into models.
 */
export interface PhraseGrouper {
	group(input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint): Promise<PhraseProposal[]>
}

/**
 * Stage 3 contract: classifier that turns a text into an `AddressTree`. Structural — any of `@mailwoman/neural`'s
 * `NeuralAddressClassifier`, a rule-based classifier, or a fake for tests satisfies this.
 */
/**
 * Structural type for the FST gazetteer matcher, compatible with
 *
 * @mailwoman/core/resolver-wof-sqlite's FSTMatcher.
 */
export interface FSTMatcherLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateID: number; depth: number },
		token: string
	): { stateID: number; accepted: boolean; depth: number } | null
	accepting(stateID: number): Array<{ wofID: number; placetype: string; referential: number }>
}

export interface ClassifierOpts {
	queryShape?: QueryShapeLite
	/**
	 * The input register (see {@link InputMode}). `formatted` runs the evidence-bundle channels deliberately OFF; the
	 * pipeline passes an explicit mode on every parse (caller override or {@link deriveInputMode} of the kind verdict).
	 */
	inputMode?: InputMode
	fst?: FSTMatcherLike
	fstBiasScale?: number
	/**
	 * Street-morphology matcher. In the pipeline this is the signal source for the FST street-context CHECK (#1315),
	 * always paired with zeroed `fstStreetMorphologyOpts` — the morphology EMISSION prior measured US-golden-negative
	 * (−48, 2026-07-25 decomposition) and stays off on the production paths; it remains reachable via direct
	 * `classifier.parse` for measured, opt-in use.
	 */
	fstStreetMorphology?: FSTMatcherLike
	/**
	 * Magnitude overrides for the morphology emission prior — the pipeline always passes the zeroed pair.
	 */
	fstStreetMorphologyOpts?: { biasScale?: number; dependentLocalityPenalty?: number }
	/**
	 * Run the deterministic postcode regex repair pass (v0.7 #35) on the decoded labels.
	 */
	postcodeRepair?: boolean
	/**
	 * #690: title-case a detected all-caps ASCII input before the model (all-caps registry/compliance data is partly
	 * OOD). Detection-restricted — mixed-case + non-ASCII input is untouched. **Default-ON** (#895 settled drift D2);
	 * `false` restores the raw-case parse.
	 */
	normalizeCase?: boolean
	/**
	 * Per-word BIO consistency repair (#727): force each SentencePiece word whose pieces DISAGREE in type to one tag via
	 * a confidence-weighted vote. Structural mirror of `@mailwoman/neural`'s `WordConsistencyOpts` (core carries no
	 * neural dependency) — see `neural/word-consistency.ts` for the semantics of each gate.
	 */
	enforceWordConsistency?:
		| boolean
		| { minMeanConfidence?: number; skipByteFallbackWords?: boolean; splitOnPunctuation?: boolean }
	/**
	 * Placetype-pair prior (placetype-pair-prior arc, #1278) — an opaque passthrough (see
	 * {@link PlacetypePairPassthrough}). `safeClassify` forwards `PipelineOpts.placetypePair` here, and the neural
	 * classifier's `parse` reads it as its own `PlacetypePairPriorOpts | false`. `@mailwoman/core` never inspects it;
	 * `undefined` is the byte-stable no-prior decode.
	 */
	placetypePair?: PlacetypePairPassthrough
}

/**
 * The word-consistency setting production parses ship with (2026-07-15): heal intra-word tag disagreement, with the
 * punctuation-separator + byte-fallback gates on and no confidence floor — the configuration that cleared golden
 * us/fr/adversarial and the parity floors with zero per-file regressions. One constant so the pipeline's
 * `safeClassify`, `parseForGeocode`, and the eval harness can't drift apart.
 */
export const WORD_CONSISTENCY_SHIP_DEFAULT = {
	skipByteFallbackWords: true,
	splitOnPunctuation: true,
} as const satisfies ClassifierOpts["enforceWordConsistency"]

export interface AddressClassifier {
	parse(text: string, opts?: ClassifierOpts): Promise<AddressTree>
}

/**
 * Injectable stage implementations. All optional — when a stage is absent, the coordinator either skips it (resolver)
 * or substitutes a no-op stub (normalize / queryShape / locale gate / kind classifier). The classifier is required for
 * the full pipeline path; without it, the coordinator can only fast-path on QueryShape known-formats.
 */
export interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: (
		input: NormalizedInputLite,
		shape: QueryShapeLite,
		opts?: { hint?: LocaleTag; machinePreferences?: MachinePreferences; environmentLocale?: LocaleTag }
	) => Promise<LocaleHint>
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	/**
	 * Coarse country router (#244). A `(normalizedText) → { country, confidence, posterior? }` predictor (a
	 * `CoarsePlacer`-backed fn); `country: null` ⇒ abstained, `"OTHER"` ⇒ off-map. When provided, a confident IN-MAP
	 * guess becomes a SOFT country prior fed into the resolver's #369 `anchorPosterior` re-rank (boosts the right-country
	 * candidate, never filters); it defers to a caller-supplied posterior (a stronger postcode anchor) and is a no-op on
	 * abstain/OTHER. Off by default → byte-stable.
	 *
	 * `posterior` (residual upgrade) is the full per-in-map-country distribution: when present it IS the
	 * `anchorPosterior` (so the resolver breaks country-ambiguous ties with its own place-level evidence); when absent
	 * the coordinator falls back to the one-hot `{ [country]: confidence }`. See
	 * docs/articles/plan/2026-06-14-coarse-placer-soft-signal-spec.md.
	 */
	placeCountry?: (normalizedText: string) => {
		country: string | null
		confidence: number
		posterior?: Record<string, number>
	}
	/**
	 * POI intent stage (spec §3.1). Runs ONLY when the kind classifier emitted `poi_query`. Returns the extracted intent,
	 * an abstain, or `null` to fall through to the full pipeline (the mis-detection safety valve — a `poi_query` kind
	 * with no extractable subject parses normally). Absent by default; wired by `createRuntimePipeline({ poiQueryKind:
	 * true })`.
	 */
	poiIntent?: (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null>
	/**
	 * Stage 2.7 phrase grouper. Emits coherent input-unit proposals consumed by Stage 3 (as conditioning) and Stage 5 (as
	 * boundary candidates). Hard dep in v0.5.0; pre-v0.5.0 callers run with no grouper and the result `phraseProposals`
	 * field is empty.
	 */
	groupPhrases?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<PhraseProposal[]>
	classifier?: AddressClassifier
	/**
	 * Pre-built FST gazetteer matcher. When provided, gazetteer matches produce additive emission biases during
	 * classification.
	 */
	fst?: FSTMatcherLike
	/**
	 * Street-morphology matcher — the signal source for the FST street-context check (#1315). Consumed ONLY with the
	 * morphology emission prior zeroed at the classify call sites (the emission prior is US-golden-negative; the gate
	 * alone is golden-flat and fragment-positive). Effective only when `fst` is also present.
	 */
	streetMorphology?: FSTMatcherLike
	resolver?: Resolver
	/**
	 * The gazetteer BACKEND (lower-level than `resolver`), enabling the reconciler's concordance axes (#478): a bounded
	 * pre-fetch turns it into the resolver-candidate + parent-chain lookups `reconcileSpans` scores with. Optional —
	 * absent, reconcile runs classifier-only (today's behavior, byte-stable).
	 */
	resolverBackend?: ResolverBackend
}

export type PipelineTiming = Record<string, number>

/**
 * The stages whose defensive wrapper degrades instead of aborting the pipeline. One id per `safe*` wrapper in
 * `runtime-pipeline.ts`; the ids are the wrapper's, not the timing map's, because a fault is about the injected stage
 * (`classifier`), not the phase that ran it (`token-classify`).
 */
export const PipelineFaultStage = {
	Classifier: "classifier",
	PhraseGrouper: "phrase-grouper",
	Resolver: "resolver",
} as const

export type PipelineFaultStage = (typeof PipelineFaultStage)[keyof typeof PipelineFaultStage]

/**
 * One stage crash the coordinator caught and degraded past.
 *
 * A fault is NOT an error return: `runPipeline` still resolves, and `tree` still carries whatever the remaining stages
 * could prove. What the fault buys the caller is the ability to tell "the model faulted and the rule-based stages
 * filled the tree back in" apart from "the model ran and found nothing" — which, before #40, was impossible from the
 * outside. See the `safeClassify` docstring for the measured failure this was written against.
 */
export interface PipelineFault {
	stage: PipelineFaultStage
	/**
	 * The thrown value's `name` (`TypeError`, `RangeError`, …), or `"Error"` when something that isn't an `Error` was
	 * thrown. Machine-stable enough to branch on; the `cause` carries the rest.
	 */
	name: string
	message: string
	/**
	 * The value the stage threw, verbatim — kept so a caller can rethrow it or read its stack. Not JSON-serializable in
	 * the useful sense; serialize `stage`/`name`/`message` when you need this on a wire.
	 */
	cause: unknown
}

/**
 * Result of one `runPipeline` call.
 */
export interface PipelineResult {
	input: string
	normalized: NormalizedInputLite
	queryShape: QueryShapeLite
	locale: LocaleHint
	kind: QueryKindResult
	/**
	 * Stage 2.7 phrase proposals when a grouper was wired. Empty array when the coordinator ran with no grouper
	 * (pre-v0.5.0 callers) or when the fast-path skipped Stage 2.7. Stage 3 consumes this as conditioning; Stage 5
	 * consumes it as boundary candidates.
	 */
	phraseProposals: PhraseProposal[]
	tree: AddressTree
	/**
	 * Present only when the poi-intent stage produced an outcome (path === "poi").
	 */
	poiIntent?: POIIntentOutcome
	timing: PipelineTiming
	/**
	 * Every stage crash the coordinator caught and degraded past, in the order they happened. **Always present** — an
	 * empty array is the coordinator stating that no stage faulted, which is a different claim from a missing field.
	 * Non-empty means the tree you are holding was produced with at least one stage down; see {@link PipelineFault}.
	 */
	faults: PipelineFault[]
	/**
	 * Query-intent advisories (ROAD_TO_V9 §4), lifted from the kind classifier's verdict. **Always present** — an empty
	 * array is the coordinator stating that the intent vocabulary examined this query and had nothing to say, which is a
	 * different claim from a missing field (the {@link faults} discipline, same reasoning).
	 *
	 * Nothing here changed which answer won. The markers are advisory by construction: the two intent kinds that could
	 * have displaced a structural incumbent are scored below it, and the two that do win the top slot (`near_me`,
	 * `poi_category`) route exactly as their incumbents did.
	 */
	intentMarkers: QueryIntentMarker[]
	/**
	 * Which path the coordinator took. `"fast-path"` skipped stages 3-5; `"poi"` took the intent branch.
	 */
	path: "fast-path" | "full" | "poi"
}
