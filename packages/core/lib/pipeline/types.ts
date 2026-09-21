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
 *   See `docs/engineering/reference/stages.md` for the full interface this implements.
 */

import type { AddressTree } from "#decoder/types"
import type { MachinePreferences } from "#pipeline/preferences"
import type { ResolveOpts, Resolver, ResolverBackend } from "#resolver/types"
import type { Section } from "#types/classifier"

export { type PipelineFault, type PipelineResult } from "#pipeline/result"
export { type MachinePreferences } from "#pipeline/preferences"

/**
 * Optional user-location signal for Stage 6 resolver scoring.
 */
export type UserLocation = { lat: number; lon: number } | { country: string } | { region: string; country: string }

/**
 * Opaque placetype-pair prior handle (placetype-pair-prior arc, #1278).
 *
 * `@mailwoman/core` carries no neural dependency, so this is a pure passthrough:
 * core never constructs or inspects it.
 * It threads the value verbatim from {@link PipelineOpts.placetypePair} into
 * {@link ClassifierOpts.placetypePair}, and on into the neural classifier's `parse` opts,
 * where it is typed concretely (`PlacetypePairPriorOpts | false`).
 *
 * The browser demo produces it via `@mailwoman/neural/web-loader`'s `LoadResult.selectPairIndexForText`.
 *
 * `undefined` (the default) is the byte-stable no-prior decode.
 */
export type PlacetypePairPassthrough = object | false

/**
 * Common opts threaded through every stage.
 */
export interface PipelineOpts {
	locale?: Intl.UnicodeBCP47LocaleIdentifier
	userLocation?: UserLocation
	/**
	 * Explicit input register (operator Decision A / GTM B10 — see {@link InputMode}).
	 *
	 * When unset the pipeline derives it from the kind classifier's verdict via {@link deriveInputMode}.
	 * Endpoint wrappers set their register default here
	 * (validation/batch → `"formatted"`, autocomplete/demo search → `"fragmented"`).
	 */
	inputMode?: InputMode
	/**
	 * Disable fast-path shortcuts.
	 * Always run the full pipeline.
	 *
	 * Does not bypass the poi_query branch.
	 * That's a routing decision (the kind classifier + `stages.poiIntent`), not a fast-path shortcut,
	 * so a `poi_query`-classified input still takes the poi branch regardless of this flag.
	 */
	forceFullPipeline?: boolean
	/**
	 * Hard cap on lookups the resolver may issue.
	 * Passed through.
	 */
	resolveOpts?: ResolveOpts
	/**
	 * #690: title-case detected all-caps ascii input before the Stage 3 classifier (helps on all-caps registry/compliance data).
	 *
	 * Threaded to `ClassifierOpts.normalizeCase`.
	 * Detection-restricted
	 *
	 * - **Default-on** (#895 settled drift D2. The classifier applies it when unset) —
	 *   byte-stable for mixed-case input either way.
	 *   Pass `false` to restore the raw-case parse.
	 */
	normalizeCase?: boolean
	/**
	 * Placetype-pair prior (placetype-pair-prior arc, #1278) — an opaque,
	 * per-parse decode-channel handle threaded verbatim to `ClassifierOpts.placetypePair`
	 * (and on to the neural classifier's `parse`).
	 *
	 * The browser demo derives it per input via `@mailwoman/neural/web-loader`'s
	 * `LoadResult.selectPairIndexForText` (locale-hint over the text shape) so a GB/NZ input
	 * gets its dependent_locality-resurrecting prior while a US/FR input stays byte-stable.
	 * `undefined` (default) = no prior.
	 *
	 * See {@link PlacetypePairPassthrough}.
	 */
	placetypePair?: PlacetypePairPassthrough
	/**
	 * #743/#194: promote a confident coarse-placer guess from the soft `anchorPosterior` boost to a hard country filter (empty→unresolved) — see {@link ResolveOpts.hardCountry}.
	 *
	 * Conditioned three ways: the placer's confidence ≥ `HARD_PLACE_COUNTRY_MIN_CONF`
	 * (ambiguous DK↔no stay soft), the country is in the coverage `HARD_PLACE_COUNTRY_SAFELIST`
	 * (or a {@link hardCountrySafelist} override), and no caller `hardCountry`/`defaultCountry`
	 * is already set. **Default-on** in the shipped `createRuntimePipeline`/`geocodeAddress`
	 * (#743, 2026-06-22) — but the safelist confines the hard filter to well-covered countries,
	 * so the low-coverage tail (FI/PL) keeps its recall on the soft path with no regression.
	 * Pass `false` to force the pre-#194 soft-only behavior.
	 */
	hardPlaceCountry?: boolean
	/**
	 * #743/#194: override the coverage safelist that bounds {@link hardPlaceCountry}. Undefined → the loaded gazetteer artifact's own coverage manifest (`resolver.artifactCoverage.hardCountrySafelist`) when it carries one, else the built-in `HARD_PLACE_COUNTRY_SAFELIST` fallback (byte-identical for artifacts predating the manifest).
	 *
	 * Supply a set to test/measure a different coverage frontier.
	 *
	 * The resolver eval passes the full in-map country set to measure unrestricted
	 * hard-resolve-rates (which is how the production safelist is grown).
	 */
	hardCountrySafelist?: ReadonlySet<string>
	signal?: AbortSignal
}

/**
 * Minimal structural shape `NormalizedInput` must satisfy.
 *
 * Compatible with @mailwoman/normalize.
 */
export interface NormalizedInputLite {
	raw: string
	normalized: string
	appliedLocale?: string
}

/**
 * Minimal structural shape `QueryShape` must satisfy.
 *
 * Compatible with @mailwoman/query-shape.
 */
export interface QueryShapeLite {
	knownFormats: ReadonlyArray<{
		format: string
		span: { start: number; end: number }
		confidence: number
	}>
	segments?: ReadonlyArray<{ body: string; index: number }>
	characterClass?: string
	/**
	 * ISO 15924 scripts the input is written in, ranked by share of its script-containing characters.
	 *
	 * It stands beside `characterClass` rather than replacing it, because they answer different
	 * questions: the class says whether a run is ideographic or numeric, which is what the tokenizer
	 * and the decoder ask, and folds Kana, Han and Hangul to one `cjk` value to do it.
	 * A consumer that needs the writing system reads here.
	 */
	scripts?: ReadonlyArray<{ script: string; share: number }>
	/**
	 * Per-token class and script.
	 *
	 * Optional so a hand-built shape stays valid; `computeQueryShape` always supplies it.
	 *
	 * The per-token script is the half a fold cannot reconstruct:
	 * `金龍酒家, 12 Gerrard Street, London WC2H 7JS` folds to `mixed`, and `mixed` names no script,
	 * so which span carried the Han was unrecoverable downstream.
	 */
	tokenClasses?: ReadonlyArray<{
		span: { start: number; end: number; body: string }
		class: string
		length: number
		script?: string
	}>
	totalLength?: number
}

/**
 * Detected (or asserted) locale + alternatives.
 */
export interface LocaleHint {
	locale: Intl.UnicodeBCP47LocaleIdentifier
	confidence: number
	alternatives: ReadonlyArray<{ locale: Intl.UnicodeBCP47LocaleIdentifier; confidence: number }>
	source: "caller" | "environment" | "machine" | "detected" | "ensemble"
	/**
	 * The ISO 15924 scripts the input is written in, ranked by share of its script-containing characters.
	 *
	 * Empty when nothing in the input names a script.
	 * A bare postcode does not.
	 *
	 * Separate from `locale`, and added because it had nowhere else to go.
	 * `locale` is one BCP-47 tag, so a Hangul address and a kanji address both had to be reported
	 * under one of them, and the rule that picks it answers `ja-JP` for every CJK input.
	 * On the Korean reference set that is every row.
	 *
	 * The tag is not wrong about routing — the character path is one weights family for Japanese,
	 * Korean and Chinese — it is wrong about what it says, and a consumer reading the hint
	 * could not tell "Japanese" from "a script I cannot resolve a language for".
	 *
	 * This field lets it say the second.
	 * `locale` keeps its current meaning and its current values.
	 * A consumer that wants the writing system reads here.
	 *
	 * Script narrows language where it is diagnostic — Hangul decides Korean on 37 of 37 rows of
	 * the Korean reference set — and does not where it is not: Han is shared, and kana decides
	 * Japanese on 356 of 11,946 JP gold rows, because 県/市/区 and most place names are written in Han.
	 *
	 * `script` is plain strings for the reason every field on this interface is:
	 * `@mailwoman/core/pipeline` declares the dependency-free shape
	 * and `@mailwoman/query-shape` owns the named `ScriptCode` union.
	 */
	script?: ReadonlyArray<{ script: string; confidence: number }>
	/**
	 * Diagnostic provenance for inferred preferences.
	 *
	 * Locale and timezone remain independent signals.
	 */
	evidence?: {
		intlLocale?: string
		timeZone?: string
		environmentLocale?: Intl.UnicodeBCP47LocaleIdentifier
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
	 * ROAD_TO_V9 §4 — the query-intent vocabulary. Four kinds that describe what the user is asking FOR rather than what their string is shaped like. They are ordinary members of this union (intent is vocabulary of the existing Stage 2.5, never a new stage), and each one, when it fires, attaches a {@link QueryIntentMarker} to the result.
	 *
	 * Two of the four are deliberately ranked below their structural incumbent and therefore surface in {@link QueryKindResult.alternatives} rather than as the top kind — see the individual docstrings in `@mailwoman/kind-classifier`'s `intent-rules.ts`. That is the D-rule discharge: the top kind is the only thing the coordinator routes on (`deriveInputMode`, `canShortCircuit`, the POI branch), so leaving it untouched is what makes the addition provably answer-neutral on the populations those incumbents already own.
	 */
	/**
	 * A single coherent place-name carrying no address grammar — no house number, no postcode, no street-type word. A strict refinement of `locality_only` (which also admits an admin tail: `Paris, FR`), scored just below it so the top kind never moves. Feeds the declared-ambiguity path: a bare toponym whose resolved candidates are not decisive gets a `declared_ambiguity` marker at geocode time.
	 */
	| "bare_toponym"
	/**
	 * Two coherent toponyms with no address grammar between them — `Paris London`. Classification plus a declared fork, never a router (ROAD_TO_V9 §4.3): structure alone cannot separate a route pair from a comma-free locality+region fragment (`Moscow Idaho`), so both interpretations are named in the marker and neither wins.
	 */
	| "route_pair"
	/**
	 * Preposition/deictic locator with no anchor — `gas station near me`, `restaurants nearby`. The query names a category and a relation to the asker, and the asker's position is not in the string. Classification only in v9: the marker states that a focus point is required and absent.
	 */
	| "near_me"
	/**
	 * A bare POI category with nowhere to search — `tacos`, `grocery store`. The anchorless subset of `poi_query`, carrying the resolved `@mailwoman/poi-taxonomy` category id on its marker. Routes exactly as `poi_query` does (the coordinator's POI branch accepts both); resolution against `poi.db` is out of scope.
	 */
	| "poi_category"

/**
 * The advisory codes an intent kind can raise.
 *
 * Named per the suggestion-layer plan's rules (`docs/superpowers/plans/2026-08-05-suggestion-layer.md` § Naming):
 * never `*Coherence` (that vocabulary belongs to the passes that decide what the answer is),
 * and never `correction`/`validation`.
 * This surface only ever reports.
 */
export const QueryIntentCode = {
	/**
	 * The query named a place, and the gazetteer's answer for that name is not decisive.
	 *
	 * Raised at resolve time (the margin is a property of the candidate list rather than of the string),
	 * so the classifier never emits it.
	 */
	DeclaredAmbiguity: "declared_ambiguity",
	/**
	 * The query admits two whole readings and the pipeline is not choosing between them.
	 *
	 * `evidence.interpretations` names both.
	 */
	DeclaredFork: "declared_fork",
	/**
	 * The query is relative to the asker and no focus point was supplied.
	 *
	 * `evidence.parameter` names the parameter that would carry one.
	 */
	FocusPointRequired: "focus_point_required",
	/**
	 * The query resolved to a POI taxonomy category.
	 *
	 * `evidence.categoryID` carries it.
	 */
	POICategory: "poi_category",
	/**
	 * The answer holds nothing of the asked-for kind, and a coverage layer surveyed
	 * the searched cell for exactly that kind.
	 *
	 * So the emptiness is a statement about the world rather than about retrieval.
	 *
	 * `evidence.coverage` carries the cell, its basis and the layer that measured it.
	 * Without exclusion-grade coverage this code is never raised, because an
	 * unsurveyed cell is unknown and never absence.
	 */
	CoverageQualifiedAbsence: "coverage_qualified_absence",
	/**
	 * An authority publishes a designation for the resolved coordinate, and this is it.
	 *
	 * The code in that authority's own vocabulary, with the product and vintage it was read from
	 * and the coverage record stating that the authority made a determination there.
	 *
	 * `evidence.layer` names the artifact; `evidence.coverage` carries the cell and its basis.
	 *
	 * The code is raised at resolve time and names the verdict's own top kind
	 * rather than a kind of its own: the marker is about the coordinate an answer reached
	 * rather than about how the query was read, so there is no intent kind to name.
	 * A reading the authority does not make raises nothing — outside its footprint there is
	 * no coverage row, and an advisory there would report a determination nobody made.
	 */
	AuthorityDesignation: "authority_designation",
	/**
	 * The query supplied components finer than the answer reached, and the answer says
	 * which ones it could not use.
	 *
	 * The counterpart of `declared_ambiguity`, and it exists because the two
	 * failures were reported asymmetrically.
	 * Too many answers raised a marker with a margin and a runner-up.
	 *
	 * Too FEW — a street parsed and a locality centroid returned — raised nothing,
	 * so `301 College Ave #101, Athens, GA 30601` and `Athens, GA` came back as the same
	 * shape of answer at the same tier with `uncertainty_m` null on both.
	 *
	 * A consumer could not tell "a city is the whole answer" from "I was handed a street
	 * and a house number and discarded them".
	 *
	 * Raised at resolve time, because the shortfall is a property of the tier reached
	 * rather than of the string.
	 * `evidence.unusedComponents` names the parsed tags the answer's tier does
	 * not carry, `evidence.impliedTier` the tier the finest of them implies,
	 * and `evidence.reachedTier` what the walk actually returned.
	 *
	 * It reports and never re-ranks: an answer that degraded for a good reason — the street is
	 * genuinely absent from coverage — raises the same marker as one that degraded for a bad one,
	 * because this surface cannot tell them apart and saying so is the honest reading.
	 * What it removes is the silence.
	 */
	DeclaredCoarserAnswer: "declared_coarser_answer",
} as const

export type QueryIntentCode = (typeof QueryIntentCode)[keyof typeof QueryIntentCode]

/**
 * One advisory the intent vocabulary raised about a query.
 *
 * Shaped after {@link PipelineFault} on purpose, and for the same reason: the caller needs to tell
 * "the pipeline considered this and had something to say" apart from "the pipeline said nothing".
 * A marker never changes which answer wins.
 *
 * It is additive, attributed, and always accompanied by the ordinary result.
 *
 * `mechanism` follows the `family:rule` convention `PhraseProposal.source`
 * established (`core/pipeline/span-proposer.ts`), so every marker names the rule
 * that produced it rather than asserting itself.
 */
export interface QueryIntentMarker {
	/**
	 * The intent kind that raised this marker.
	 *
	 * Present in {@link QueryKindResult} as either the top `kind` or an entry in `alternatives`.
	 * A marker whose kind appears in neither is a bug in the producer.
	 */
	kind: QueryKind
	code: QueryIntentCode
	/**
	 * `family:rule` — `kind:bare_toponym`, `kind:route_pair`, `resolver:dominance_margin`.
	 *
	 * Never `"unknown"`.
	 */
	mechanism: string
	/**
	 * Human-readable, for a surface that shows it.
	 *
	 * Not machine-stable.
	 * Branch on `code`.
	 */
	message: string
	/**
	 * The measurement behind the marker, so it is auditable rather than assertive.
	 *
	 * Absent when the rule that fired had nothing to measure (meaning-of-zero: absent, never an empty object).
	 */
	evidence?: Record<string, unknown>
}

export interface QueryKindResult {
	kind: QueryKind
	confidence: number
	alternatives: ReadonlyArray<{ kind: QueryKind; confidence: number }>
	/**
	 * Advisories raised by the intent vocabulary (ROAD_TO_V9 §4).
	 *
	 * Optional on this interface — a pre-intent classifier (including `runtime-pipeline.ts`'s built-in default)
	 * simply doesn't set it — but `PipelineResult.intentMarkers` is always an array,
	 * so a consumer reading the result never has to distinguish "absent" from "empty".
	 */
	intentMarkers?: ReadonlyArray<QueryIntentMarker>
}

/**
 * The input register (operator Decision A, 2026-07-28 — the Option-A evidence-bundle verdict):
 * `fragmented` is the map-search register (a human typing "belleville" or "12 rue de la paix"); `formatted`
 * is the validation/record register (a checkout form or CRM row submitting a full postal address).
 *
 * The evidence-bundle channels feed only in fragmented mode — three training runs showed
 * they lift the fragment register (admin-street homonym +0.765 lower+heal) while degrading
 * full-address parses (the flip census, `.superpowers/sdd/progress.md` 2026-07-28).
 * Explicitly settable on every surface (CLI/API); when unset, {@link deriveInputMode}
 * maps the kind-classifier's verdict.
 *
 * Endpoint defaults (GTM B10): validation/batch/CSV → formatted. autocomplete/demo search → fragmented.
 * Plain parse → derived.
 */
export type InputMode = "fragmented" | "formatted"

/**
 * Map a {@link QueryKind} to its {@link InputMode} register.
 *
 * Multi-component postal specifications (`structured_address`/`po_box`/`intersection`)
 * are the formatted register.
 * Single-thing lookups (postcode, locality, landmark, POI, vague) are fragments.
 *
 * Never keyed on case — lowercase is the primary user register (operator doctrine).
 *
 * The four ROAD_TO_V9 §4 intent kinds are all fragments and all reach the register
 * through the `default` arm, which is why adding them changed no case in this switch:
 * a bare toponym, a route pair, a `near me` and a bare POI category are each a person
 * typing one thing into a search box, never a form submitting a postal record.
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
 * The structured POI intent — the pluggable boundary between detection (kind classifier),
 * the executors (Plan 3's poi.db SQL compiler), and the export formats (OverpassQL emitter).
 *
 * Category ids are `@mailwoman/poi-taxonomy` ids carried as plain strings — core stays lexicon-free.
 * The branded type lives with the data package.
 *
 * Spec §3.2: docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md
 */
export interface POIIntent {
	subject:
		| {
				kind: "category"
				/**
				 * Every category the subject reaches.
				 *
				 * One id unless the subject lookup returned a set to be searched together —
				 * an activity afforded by several establishment kinds reaches one id per kind — in
				 * which case the executor searches the union and the candidate ordering decides the answer.
				 * The order is the lookup's enumeration and states no preference:
				 * nothing may read position as rank.
				 */
				categoryIDs: string[]
				matched: string
				/**
				 * How the set was bound to the place, present only when at least one
				 * reached category carried a country scope.
				 *
				 * `anchorCountry` is the resolved anchor's ISO 3166-1 alpha-2 country, or `null`
				 * when no anchor resolved to one — and `null` admits no scoped claim.
				 * `excludedCategoryIDs` are the categories every one of whose authorities
				 * scoped its claim to countries that do not include it.
				 *
				 * They were reached by the phrase and are not in `categoryIDs`.
				 *
				 * A set that empties this way abstains as `country_scope_excluded`.
				 */
				countryBinding?: { anchorCountry: string | null; excludedCategoryIDs: string[] }
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
 * One executed POI search result (spec §3.4. Produced by the executor, absent pre-execution).
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
	 * Overture gers id — nullable metadata only, never a key (the #470 rule).
	 */
	gersID: string | null
	/**
	 * Read-time WOF ancestry, deepest-first — the paid-down half of the poiQueryKind register row's debt.
	 *
	 * Attached by the executor only when a reverse geocoder was wired
	 * (`runtime-pipeline.ts`'s lazy `WOFReverseGeocoder`); house meaning-of-zero style —
	 * absent (the key is omitted), never an empty array or `undefined`-valued,
	 * when no reverse geocoder is available.
	 */
	ancestry?: ReadonlyArray<{ placetype: string; name: string; wofID: number }>
	distanceM?: number
}

/**
 * Outcome of the poi-intent stage.
 *
 * `abstain` = the query is POI-shaped but unanswerable as asked
 * (e.g. No executor wired for a build-local-only category) — surfaces map it to their
 * native empty-result envelope instead of a mangled parse.
 */
export type POIIntentOutcome =
	| { type: "intent"; intent: POIIntent; results?: POIResult[] }
	| { type: "abstain"; reason: string }

/**
 * Stage 2.7 phrase grouper output.
 *
 * Coarse phrase-shape hypothesis attached to a `Section` (sub-Span of the tokenized input).
 * The classifier (Stage 3) conditions on these proposals so it can answer the simpler
 * "what type is this proposed span?" instead of jointly discovering boundaries and types.
 *
 * The reconciler (Stage 5) consumes them as boundary candidates for joint decoding.
 *
 * Taxonomy is purely structural — no place-name knowledge.
 * A `LOCALITY_PHRASE` proposal is "this looks shaped like a multi-word capitalized
 * phrase that could be a city name" — not "this is New York."
 *
 * Typing the span is the classifier's job.
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
 * One phrase proposal emitted by Stage 2.7.
 *
 * The interface:
 *
 * - `span`: the input span (a sub-span of the tokenized input) the proposal applies to.
 * - `kindHypothesis`: structural shape this span looks like.
 * - `confidence`: 0..1 score.
 *   Used by downstream stages to weight proposals.
 *
 * Per "possibilities not constraints", emit a proposal whenever a rule fires — overlapping proposals
 * over the same tokens are expected (e.g. `Saint Petersburg` may surface as one `LOCALITY_PHRASE`
 * and two `LOCALITY_PHRASE`s, with confidence ordering signalling which the grouper prefers).
 */
export interface PhraseProposal {
	span: Section
	kindHypothesis: PhraseKind
	confidence: number
}

/**
 * Stage 2.7 interface.
 *
 * Structural — any of the rule-based grouper (`@mailwoman/phrase-grouper`),
 * a learned span proposer (future), or a fake for tests satisfies this.
 * Async so the coordinator can stay uniform even when implementations call into models.
 */
export interface PhraseGrouper {
	group(input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint): Promise<PhraseProposal[]>
}

/**
 * Stage 3 interface: classifier that turns a text into an `AddressTree`.
 *
 * Structural — any of `@mailwoman/neural`'s `NeuralAddressClassifier`,
 * a rule-based classifier, or a fake for tests satisfies this.
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
	 * The input register (see {@link InputMode}).
	 *
	 * `formatted` runs the evidence-bundle channels deliberately off.
	 * The pipeline passes an explicit mode on every parse
	 * (caller override or {@link deriveInputMode} of the kind verdict).
	 */
	inputMode?: InputMode
	fst?: FSTMatcherLike
	fstBiasScale?: number
	/**
	 * Street-morphology matcher.
	 *
	 * In the pipeline this is the signal source for the FST street-context check (#1315),
	 * always paired with zeroed `fstStreetMorphologyOpts`.
	 * The morphology emission prior measured US-golden-negative (−48, 2026-07-25 decomposition)
	 * and stays off on the production paths.
	 *
	 * It remains reachable via direct `classifier.parse` for measured, opt-in use.
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
	 * #690: title-case a detected all-caps ascii input before the model (all-caps registry/compliance data is partly OOD).
	 *
	 * Detection-restricted — mixed-case + non-ascii input is untouched. **Default-on**
	 * (#895 settled drift D2); `false` restores the raw-case parse.
	 */
	normalizeCase?: boolean
	/**
	 * Per-word BIO consistency repair (#727): force each SentencePiece word whose pieces
	 * disagree in type to one tag via a confidence-weighted vote.
	 *
	 * Structural mirror of `@mailwoman/neural`'s `WordConsistencyOpts` (core carries no neural dependency) —
	 * see `neural/word-consistency.ts` for the semantics of each check.
	 */
	enforceWordConsistency?:
		| boolean
		| { minMeanConfidence?: number; skipByteFallbackWords?: boolean; splitOnPunctuation?: boolean }
	/**
	 * Placetype-pair prior (placetype-pair-prior arc, #1278) — an opaque passthrough
	 * (see {@link PlacetypePairPassthrough}).
	 *
	 * `safeClassify` forwards `PipelineOpts.placetypePair` here, and the neural classifier's
	 * `parse` reads it as its own `PlacetypePairPriorOpts | false`.
	 * `@mailwoman/core` never inspects it; `undefined` is the byte-stable no-prior decode.
	 */
	placetypePair?: PlacetypePairPassthrough
}

/**
 * The word-consistency setting production parses ship with (2026-07-15): heal intra-word
 * tag disagreement, with the punctuation-separator + byte-fallback conditions on
 * and no confidence floor — the configuration that cleared golden us/fr/adversarial
 * and the parity floors with zero per-file regressions.
 *
 * One constant so the pipeline's `safeClassify`, `parseForGeocode`, and the eval harness can't drift apart.
 */
export const WORD_CONSISTENCY_SHIP_DEFAULT = {
	skipByteFallbackWords: true,
	splitOnPunctuation: true,
} as const satisfies ClassifierOpts["enforceWordConsistency"]

export interface AddressClassifier {
	parse(text: string, opts?: ClassifierOpts): Promise<AddressTree>
}

/**
 * The Stage-2 locale detector the coordinator calls: the normalized input
 * and its shape in, a {@link LocaleHint} out.
 *
 * The caller's hint wins outright.
 * An environment locale sits below it and above inferred machine preferences.
 *
 * `@mailwoman/locale-hint` implements it over the query shape alone.
 */
export type LocaleDetector = (
	input: NormalizedInputLite,
	shape: QueryShapeLite,
	opts?: {
		hint?: Intl.UnicodeBCP47LocaleIdentifier
		machinePreferences?: MachinePreferences
		environmentLocale?: Intl.UnicodeBCP47LocaleIdentifier
	}
) => Promise<LocaleHint>

/**
 * Injectable stage implementations.
 *
 * All optional — when a stage is absent, the coordinator either skips it (resolver) or substitutes
 * a no-op stub (normalize / queryShape / `@mailwoman/locale-check` stage / kind classifier).
 * The classifier is required for the full pipeline path.
 *
 * Without it, the coordinator can only fast-path on QueryShape known-formats.
 */
export interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: LocaleDetector
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	/**
	 * Coarse country router (#244).
	 *
	 * A `(normalizedText) → { country, confidence, posterior? }` predictor
	 * (a `CoarsePlacer`-backed fn); `country: null` ⇒ abstained, `"other"` ⇒ off-map.
	 * When provided, a confident IN-MAP guess becomes a soft country prior fed into the resolver's
	 * #369 `anchorPosterior` re-rank (boosts the right-country candidate, never filters); it defers
	 * to a caller-supplied posterior (a stronger postcode anchor) and is a no-op on abstain/other.
	 * Off by default → byte-stable.
	 *
	 * `posterior` (residual upgrade) is the full per-in-map-country distribution: when present it is the
	 * `anchorPosterior` (so the resolver breaks country-ambiguous ties with its own place-level evidence);
	 * when absent the coordinator falls back to the one-hot `{ [country]: confidence }`.
	 * See docs/articles/plan/2026-06-14-coarse-placer-soft-signal-spec.md.
	 */
	placeCountry?: (normalizedText: string) => {
		country: string | null
		confidence: number
		posterior?: Record<string, number>
	}
	/**
	 * POI intent stage (spec §3.1).
	 *
	 * Runs only when the kind classifier emitted `poi_query`.
	 * Returns the extracted intent, an abstain, or `null` to fall through to the full pipeline
	 * (the mis-detection safety valve — a `poi_query` kind with no extractable subject parses normally).
	 *
	 * Absent by default.
	 * Wired by `createRuntimePipeline({ poiQueryKind: true })`.
	 */
	poiIntent?: (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null>
	/**
	 * Stage 2.7 phrase grouper.
	 *
	 * Emits coherent input-unit proposals consumed by Stage 3 (as conditioning)
	 * and Stage 5 (as boundary candidates).
	 * Hard dep in v0.5.0. pre-v0.5.0 callers run with no grouper and the result
	 * `phraseProposals` field is empty.
	 */
	groupPhrases?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<PhraseProposal[]>
	classifier?: AddressClassifier
	/**
	 * Pre-built FST gazetteer matcher.
	 *
	 * When provided, gazetteer matches produce additive emission biases during classification.
	 */
	fst?: FSTMatcherLike
	/**
	 * Street-morphology matcher — the signal source for the FST street-context check (#1315).
	 *
	 * Consumed only with the morphology emission prior zeroed at the classify call sites
	 * (the emission prior is US-golden-negative. The check alone is golden-flat and fragment-positive).
	 * Effective only when `fst` is also present.
	 */
	streetMorphology?: FSTMatcherLike
	resolver?: Resolver
	/**
	 * The gazetteer backend (lower-level than `resolver`), enabling the reconciler's
	 * concordance axes (#478): a bounded pre-fetch turns it into the resolver-candidate +
	 * parent-chain lookups `reconcileSpans` scores with.
	 *
	 * Optional — absent, reconcile runs classifier-only (today's behavior, byte-stable).
	 */
	resolverBackend?: ResolverBackend
}

export type PipelineTiming = Record<string, number>

/**
 * The stages whose defensive wrapper degrades instead of aborting the pipeline.
 *
 * One id per `safe*` wrapper in `runtime-pipeline.ts`; the ids are the wrapper's
 * rather than the timing map's, because a fault is about the injected stage (`classifier`),
 * not the phase that ran it (`token-classify`).
 */
export const PipelineFaultStage = {
	Classifier: "classifier",
	PhraseGrouper: "phrase-grouper",
	Resolver: "resolver",
} as const

export type PipelineFaultStage = (typeof PipelineFaultStage)[keyof typeof PipelineFaultStage]
