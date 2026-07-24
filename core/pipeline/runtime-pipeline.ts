/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runPipeline` — the runtime coordinator that composes all six stages.
 *
 *   Generic over stage implementations (see `types.ts::RuntimePipelineStages`). Each stage is
 *   injected; the coordinator handles composition, timing, fast-path routing, and graceful
 *   degradation when stages are absent.
 *
 *   Implementation contract per `docs/articles/plan/reference/STAGES.md`.
 */

import type { AddressNode, AddressTree } from "../decoder/types.ts"
import type { ComponentTag } from "../types/component.ts"
import { prefetchReconcileLookups } from "./reconcile-lookups.ts"
import type { ClassifierCandidate } from "./reconcile.ts"
import { reconcileSpans } from "./reconcile.ts"
import { aggregateSpanLogits } from "./span-logit-aggregation.ts"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "./types.ts"
import type {
	AddressClassifier,
	ClassifierOpts,
	FSTMatcherLike,
	LocaleHint,
	LocaleTag,
	NormalizedInputLite,
	PhraseProposal,
	PipelineOpts,
	PipelineResult,
	PlacetypePairPassthrough,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "./types.ts"

/**
 * Known QueryShape format strings that indicate "this token is a postcode". Mirrors the set in
 * `@mailwoman/kind-classifier` — kept duplicated so core/pipeline has no dep on kind-classifier.
 */
const POSTCODE_FORMATS: ReadonlySet<string> = new Set([
	"us_zip",
	"us_zip4",
	"uk_postcode",
	"fr_postcode",
	"de_postcode",
	"ca_postcode",
	"jp_postcode",
])

function isPostcodeFormat(format: string): boolean {
	return POSTCODE_FORMATS.has(format)
}

/**
 * Anchor weight for the coarse-placer's country prior (#244). Lower than the postcode anchor's 2.0 default — a
 * whole-string country guess is a broader, softer signal than a postcode that pins the country, so it blends more
 * gently with the candidate score.
 */
const COARSE_PLACER_ANCHOR_WEIGHT = 1.0

// #194: minimum placer confidence to promote the soft country prior to a HARD filter (empty→unresolved).
// The placer already abstains below 0.9 in-map MASS (open-set rule), but the per-country argmax prob
// can still be split across neighbours (DK↔NO, EE↔LT↔LV); requiring a high argmax confidence keeps the
// hard filter to the cases the model is sure of (FI/PL routinely score ~1.0) and leaves the ambiguous
// ones on the soft path. Deliberately strict — a wrong hard country is the #244 M2 misroute failure.
const HARD_PLACE_COUNTRY_MIN_CONF = 0.9

// #743/#194 coverage guard: countries whose candidate gazetteer is complete enough that hard-filtering
// is a PURE WIN — measured hard-resolve-rate ≥ 95% on held-out OpenAddresses points, so a hard-filter
// "miss → unresolved" is rare and almost always a genuine non-match, not a coverage gap. A confident
// placement OUTSIDE this set stays on the SOFT prior, so the low-coverage tail (FI/PL/…) keeps its
// recall until its gazetteer is filled (#193) — the win for covered countries, no recall regression
// for the rest (DeepSeek-advised, 2026-06-22). Measured resolve-rate under hard: US 100, FR 100, DE
// 100, ES 99.8, NL 97.3, IT 96.8 (in); FI 69.5, PL 77.8 (out). Grow as more countries clear the bar.
// Override per-call with `PipelineOpts.hardCountrySafelist` (the eval measures ungated to grow it).
// GB + CA added at the #928 promote (2026-07-06): the postcodeCountryPrior format signal routes them
// confidently (the language placer conflated both with US), and their OSM-panel gates passed with the
// hard filter on — GB 271/300 ok / 7 unresolved, CA 200/300 ok / 31 unresolved (night 34).
export const HARD_PLACE_COUNTRY_SAFELIST: ReadonlySet<string> = new Set([
	"US",
	"ES",
	"IT",
	"NL",
	"DE",
	"FR",
	"GB",
	"CA",
	// AU added with the #244 AU placer class (2026-07-06): 150k-row G-NAF training → AU test-acc 100%,
	// and the hard filter is recall-SAFE on the AU panel (unresolved 4→2 while abroad 43→20).
	"AU",
])

/**
 * #912 lever 1 — is this parse a single BARE locality ("Paris", "Dublin")? The coarse placer is out-of-distribution on
 * one-token city names (trained on full addresses): measured on the gauntlet's bare-namesake rows it emitted Paris→IT
 * .35, Melbourne→GB .66 — all wrong, and even sub-threshold the SOFT posterior still re-ranks the resolver toward the
 * wrong country. A bare locality carries no country evidence the placer can read that the resolver's exact-tier +
 * population ranking doesn't already use better — so both production placeCountry call sites (the runtime pipeline and
 * `geocodeAddress`) ABSTAIN on this shape. Any second non-empty component makes the input address-shaped and the placer
 * runs as before.
 */
export function isBareLocalityTree(tree: AddressTree): boolean {
	let sawLocality = false
	const stack = [...tree.roots]

	while (stack.length > 0) {
		const node = stack.pop()!

		if (node.tag === "locality") {
			sawLocality = true
		} else if (node.value.trim() !== "") return false
		stack.push(...node.children)
	}

	return sawLocality
}

/**
 * #743/#194: the shared coverage-guard gate — decide whether a confident coarse-placer country should become a HARD
 * candidate filter. Exported so the two production placeCountry call sites (the runtime pipeline AND `geocodeAddress`)
 * apply the SAME three gates and can't drift: confidence ≥ {@link HARD_PLACE_COUNTRY_MIN_CONF}, country in the safelist
 * (override or the default {@link HARD_PLACE_COUNTRY_SAFELIST}), and no caller-set hard/default country to respect.
 * Returns the country to hard-filter, or `undefined` to stay on the soft prior.
 */
export function hardCountryFor(
	placedCountry: string,
	placedConfidence: number,
	existing: { hardCountry?: string; defaultCountry?: string },
	hardPlaceCountry: boolean | undefined,
	safelist: ReadonlySet<string> | undefined
): string | undefined {
	if (!hardPlaceCountry) return undefined

	if (placedConfidence < HARD_PLACE_COUNTRY_MIN_CONF) return undefined

	if (!(safelist ?? HARD_PLACE_COUNTRY_SAFELIST).has(placedCountry)) return undefined

	if (existing.hardCountry || existing.defaultCountry) return undefined

	return placedCountry
}

function isPostcodeFormatHit(hit: { format: string }): boolean {
	return isPostcodeFormat(hit.format)
}

/** Pass-through normalize used when no `normalize` stage is wired. */
function identityNormalize(raw: string, opts?: { locale?: string }): NormalizedInputLite {
	return { raw, normalized: raw, appliedLocale: opts?.locale }
}

/** No-op query-shape used when no `computeQueryShape` stage is wired. */
function emptyQueryShape(): QueryShapeLite {
	return { knownFormats: [] }
}

/** Default locale detector: trusts the caller's hint, or falls back to `und`. */
async function defaultDetectLocale(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	opts?: { hint?: LocaleTag }
): Promise<LocaleHint> {
	const locale = opts?.hint ?? "und"

	return {
		locale,
		confidence: opts?.hint ? 1.0 : 0.0,
		alternatives: [],
		source: opts?.hint ? "caller" : "detected",
	}
}

/** Default kind classifier: always returns `structured_address` with low confidence (no fast-path). */
async function defaultClassifyKind(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	_locale: LocaleHint
): Promise<QueryKindResult> {
	return {
		kind: "structured_address",
		confidence: 0.0,
		alternatives: [],
	}
}

/**
 * Decide whether to short-circuit stages 3-5 and go straight to resolve. Conservative: requires high kind-classifier
 * confidence AND a matching QueryShape known-format hit. See `STAGES.md#fast-path-routing` for the rationale.
 */
function canShortCircuit(kind: QueryKindResult, shape: QueryShapeLite, opts?: PipelineOpts): boolean {
	if (opts?.forceFullPipeline) return false

	if (kind.confidence < 0.95) return false

	if (kind.kind === "postcode_only") {
		return shape.knownFormats.some(isPostcodeFormatHit)
	}

	if (kind.kind === "locality_only") {
		return (shape.totalLength ?? Infinity) <= 30 && shape.characterClass === "alpha"
	}

	return false
}

/**
 * Build a stub `AddressTree` for the fast-path case (no classifier ran). Single root node tagged by the QueryShape's
 * known-format hit.
 */
function buildFastPathTree(text: string, kind: QueryKindResult, shape: QueryShapeLite): AddressTree {
	if (kind.kind === "postcode_only") {
		const hit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))

		if (hit) {
			return {
				raw: text,
				roots: [
					{
						tag: "postcode",
						value: text.slice(hit.span.start, hit.span.end),
						start: hit.span.start,
						end: hit.span.end,
						confidence: hit.confidence,
						children: [],
						source: "query-shape",
						sourceID: hit.format,
					},
				],
			}
		}
	}

	if (kind.kind === "locality_only") {
		return {
			raw: text,
			roots: [
				{
					tag: "locality",
					value: text.trim(),
					start: 0,
					end: text.length,
					confidence: kind.confidence,
					children: [],
					source: "query-shape",
					sourceID: "kind:locality_only",
				},
			],
		}
	}

	return { raw: text, roots: [] }
}

/**
 * Run the runtime pipeline.
 *
 * Composition order (per STAGES.md):
 *
 * 1. Normalize (or identity)
 * 2. Compute QueryShape (or empty)
 * 3. Locale gate (or caller-trust)
 * 4. Kind classifier (or default structured_address)
 * 5. Branch: fast-path → resolver; full → classifier → resolver
 *
 * Per-stage timing recorded on `result.timing`. Fast-path stages are absent from the timing map.
 */
export async function runPipeline(
	raw: string,
	stages: RuntimePipelineStages,
	opts?: PipelineOpts
): Promise<PipelineResult> {
	const timing: Record<string, number> = {}
	const t0 = performance.now()

	const normalize = stages.normalize ?? identityNormalize
	const computeQueryShape = stages.computeQueryShape ?? emptyQueryShape
	const detectLocale = stages.detectLocale ?? defaultDetectLocale
	const classifyKind = stages.classifyKind ?? defaultClassifyKind

	throwIfAborted(opts)
	const normalized = normalize(raw, { locale: opts?.locale })
	timing["normalize"] = performance.now() - t0

	// Coarse country router (#244, soft prior). A confident in-map guess becomes an `anchorPosterior`
	// the resolver's #369 re-rank BOOSTS (never filters); abstain/OTHER → no signal. Defers to a
	// caller-supplied posterior (a stronger postcode anchor — never overwrite it). Off (no stage) →
	// `effectiveOpts === opts` → byte-stable. See the soft-signal wiring spec.
	let effectiveOpts = opts
	// #912 lever 1: true when the anchorPosterior in effectiveOpts came from the placer (not the
	// caller) — the post-parse bare-locality abstention below only strips what the placer added.
	let placerAnchorApplied = false

	if (stages.placeCountry) {
		const tPlace = performance.now()
		const placed = stages.placeCountry(normalized.normalized)
		timing["place-country"] = performance.now() - tPlace

		if (placed.country && placed.country !== "OTHER" && !opts?.resolveOpts?.anchorPosterior) {
			// #194/#743: promote a CONFIDENT placement to a HARD country filter (empty→unresolved) when the
			// caller opts in, the confidence clears the bar, AND the country is in the coverage SAFELIST. The
			// soft posterior alone can't move a LOW-population place (a FI town loses to a high-pop namesake
			// even when FI is pinned); the hard filter does. Three gates: confidence (ambiguous DK↔NO stay
			// soft), the safelist (only well-covered countries — where a miss is a genuine non-match, not a
			// coverage gap — hard-filter; the low-coverage tail keeps its recall on the soft path), and the
			// caller's own hardCountry/defaultCountry is never overwritten. Pass `hardCountrySafelist` to
			// override the default set (the eval measures ungated to grow it).
			const hardCountry = hardCountryFor(
				placed.country,
				placed.confidence,
				opts?.resolveOpts ?? {},
				opts?.hardPlaceCountry,
				opts?.hardCountrySafelist
			)
			placerAnchorApplied = true
			effectiveOpts = {
				...opts,
				resolveOpts: {
					...opts?.resolveOpts,
					// The full in-map distribution when the placer supplies it (resolver breaks ties); else the
					// one-hot argmax (the M2 behavior).
					anchorPosterior: placed.posterior ?? { [placed.country]: placed.confidence },
					anchorWeight: opts?.resolveOpts?.anchorWeight ?? COARSE_PLACER_ANCHOR_WEIGHT,
					...(hardCountry ? { hardCountry } : {}),
				},
			}
		}
	}

	throwIfAborted(opts)
	const tQs = performance.now()
	const queryShape = computeQueryShape(normalized, { locale: opts?.locale })
	timing["query-shape"] = performance.now() - tQs

	throwIfAborted(opts)
	const tLocale = performance.now()
	const locale = await detectLocale(normalized, queryShape, { hint: opts?.locale })
	timing["locale-gate"] = performance.now() - tLocale

	throwIfAborted(opts)
	const tKind = performance.now()
	const kind = await classifyKind(normalized, queryShape, locale)
	timing["kind-classifier"] = performance.now() - tKind

	// POI branch (spec §3.1). Only reachable when a poi-aware kind classifier was wired (the
	// default classifier never emits `poi_query`), and only acts when the stage is present —
	// both absent by default, so the flag-off pipeline is byte-identical by construction. A
	// `null` outcome falls through to the full pipeline: a poi_query kind with no extractable
	// subject is a mis-detection, and the address path is the safe interpretation.
	if (kind.kind === "poi_query" && stages.poiIntent) {
		throwIfAborted(opts)
		const tPoi = performance.now()
		const poiOutcome = await stages.poiIntent(normalized, locale, effectiveOpts)
		timing["poi-intent"] = performance.now() - tPoi

		if (poiOutcome) {
			const emptyTree: AddressTree = { raw: normalized.normalized, roots: [] }
			const tree = poiOutcome.type === "intent" ? (poiOutcome.intent.anchor?.tree ?? emptyTree) : emptyTree

			return {
				input: raw,
				normalized,
				queryShape,
				locale,
				kind,
				phraseProposals: [],
				tree,
				poiIntent: poiOutcome,
				timing,
				path: "poi",
			}
		}
	}

	// Fast-path: trivial inputs short-circuit stages 3-5. The fast-path tree is built from
	// QueryShape's format hits + kind alone — useful even without a wired resolver (a consumer
	// who just wants the parsed structure for a bare postcode shouldn't be forced to pay for the
	// classifier).
	if (canShortCircuit(kind, queryShape, opts)) {
		let tree = buildFastPathTree(normalized.normalized, kind, queryShape)

		if (stages.resolver) {
			throwIfAborted(opts)
			const tResolve = performance.now()
			tree = await safeResolve(stages.resolver, tree, effectiveOpts)
			timing["resolve"] = performance.now() - tResolve
		}

		return {
			input: raw,
			normalized,
			queryShape,
			locale,
			kind,
			phraseProposals: [],
			tree,
			timing,
			path: "fast-path",
		}
	}

	// Full pipeline.
	// Stage 2.7 — phrase grouper. Optional injection; runs when wired. Proposals flow forward to
	// stages 3 + 5 (today: surfaced on the result; tomorrow: passed in as classifier conditioning).
	let phraseProposals: PhraseProposal[] = []

	if (stages.groupPhrases) {
		throwIfAborted(opts)
		const tGroup = performance.now()
		phraseProposals = await safeGroupPhrases(stages.groupPhrases, normalized, queryShape, locale)
		timing["phrase-grouper"] = performance.now() - tGroup
	}

	let tree: AddressTree = { raw: normalized.normalized, roots: [] }
	// Captured from the joint-reconcile path so the grouper-audit can defer to the classifier's
	// per-span verdict on orphaned spans (see the assignment + grouperAudit below).
	let auditClassifierTopK: ClassifierCandidate[] | undefined

	// Joint-reconcile path: RETIRED AS DEFAULT 2026-06-14 (#427 promoted it; this de-promotes it).
	// A reconcile-vs-raw-neural audit on two non-circular US holdouts (Travis E-911 + 7-state
	// OpenAddresses) found it BREAKS the street+house_number geocode precondition on 77-84% of clean
	// US addresses and fixes 0% — the phrase grouper bundles the house number into the STREET_PHRASE
	// ("3075 Hill Street") and reconcileSpans then fuses the whole span into one node, leaving no
	// separate `street`. Confirmed on golden v0.1.2 US+FR (n=4507, per-tag recall vs raw argmax):
	// street -25.6pp, house_number -23.1pp, locality -2.3pp, venue -0.6pp, region/postcode/unit flat.
	// It is worse-or-flat on EVERY tag — including venue, the thing #427 promoted it for. The #427
	// re-gate's "DE +25pp / IT-ES +15pp" was loose street-STRING recall on OOD inputs (where raw
	// neural mangles the street); it never measured the geocode precondition our evals grade on raw
	// neural, so the regression was invisible. The destructive piece is the grouper HN-bundling (see
	// the tracked issue); until that's fixed, argmax is the correct default. Set `jointReconcile: true`
	// to opt back into reconcile (the A/B harnesses do). Report:
	// docs/articles/evals/experiments/2026-06-14-reconcile-retirement.md.
	const jointEnabled = opts?.jointReconcile ?? opts?.forceJointReconcile ?? false
	const useJointReconcile =
		jointEnabled && phraseProposals.length > 0 && stages.classifier && "parseWithLogits" in stages.classifier

	if (useJointReconcile) {
		const classifierWithLogits = stages.classifier as AddressClassifier & {
			parseWithLogits: (
				text: string,
				opts?: ClassifierOpts
			) => Promise<{ tree: AddressTree; logits: number[][]; pieces: Array<{ start: number; end: number }> }>
		}

		throwIfAborted(opts)
		const tClassify = performance.now()
		const {
			tree: argmaxTree,
			logits,
			pieces,
		} = await classifierWithLogits.parseWithLogits(normalized.normalized, { queryShape, fst: stages.fst })
		timing["token-classify"] = performance.now() - tClassify

		throwIfAborted(opts)
		const tReconcile = performance.now()

		// The classifier must expose its label vocabulary so the aggregation can strip BIO prefixes.
		// NeuralAddressClassifier surfaces this as `cfg.labels` — extracted via structural typing here.
		const labels: readonly string[] =
			"labels" in classifierWithLogits ? (classifierWithLogits as unknown as { labels: readonly string[] }).labels : []

		const classifierTopK = aggregateSpanLogits(
			logits,
			pieces,
			phraseProposals.map((p) => ({ start: p.span.start, end: p.span.end })),
			{ labels, text: normalized.normalized }
		)

		if (classifierTopK.length > 0) {
			// Concordance axes (#478): when the caller wires a backend, one bounded pre-fetch
			// activates the resolver-candidate + parent-chain scoring the reconciler already
			// implements. Absent backend = classifier-only reconcile (byte-stable).
			// Country constraint from the locale gate's BCP-47 tag ("en-US" -> "US"); absent or
			// und-like tags pass no constraint (ranking alone decides — matches resolveTree's default).
			const localeCountry = locale.locale.split("-")[1]?.toUpperCase()
			const lookups = stages.resolverBackend
				? await prefetchReconcileLookups(
						stages.resolverBackend,
						normalized.normalized,
						classifierTopK,
						localeCountry && localeCountry.length === 2 ? { defaultCountry: localeCountry } : {}
					)
				: undefined
			const result = reconcileSpans({
				raw: normalized.normalized,
				phraseProposals,
				classifierTopK,
				...(lookups ? { resolverCandidates: lookups.resolverCandidates, parentChain: lookups.parentChain } : {}),
			})
			tree = result.tree
			// The reconciler can leave a span uncovered (e.g. it picked the single-token street
			// `Trento` over `Via Trento`, orphaning `Via`). The grouper-audit below would then promote
			// that orphan's LOCALITY_PHRASE proposal to a `locality` node — even though the classifier
			// confidently typed it `street`. Hand the audit the classifier's per-span verdict so it
			// respects that opinion instead of trusting the structural phrase kind (#425 re-gate).
			auditClassifierTopK = classifierTopK
		} else {
			tree = argmaxTree
		}
		timing["reconcile"] = performance.now() - tReconcile
	} else if (stages.classifier) {
		throwIfAborted(opts)
		const tClassify = performance.now()
		tree = await safeClassify(
			stages.classifier,
			normalized.normalized,
			queryShape,
			stages.fst,
			opts?.normalizeCase,
			opts?.placetypePair
		)
		timing["token-classify"] = performance.now() - tClassify
	}

	if (phraseProposals.length > 0 && tree.roots.length >= 0) {
		const tAudit = performance.now()
		tree = grouperAudit(tree, phraseProposals, normalized.normalized, auditClassifierTopK)
		timing["grouper-audit"] = performance.now() - tAudit
	}

	if (stages.resolver) {
		throwIfAborted(opts)
		const tResolve = performance.now()

		// #912 lever 1: the placer abstains on a single bare locality — strip ONLY the anchor it
		// added (a caller-supplied posterior was never overwritten and passes through untouched).
		if (placerAnchorApplied && isBareLocalityTree(tree)) {
			effectiveOpts = opts
		}
		tree = await safeResolve(stages.resolver, tree, effectiveOpts)
		timing["resolve"] = performance.now() - tResolve
	}

	return {
		input: raw,
		normalized,
		queryShape,
		locale,
		kind,
		phraseProposals,
		tree,
		timing,
		path: "full",
	}
}

/**
 * Throws the signal's reason if aborted. Coarse-grained cancellation: we check between stages, so the longest
 * cancellation latency is one stage's runtime. Fine-grained mid-stage cancellation requires plumbing `signal` into each
 * stage's contract (`detectLocale`, `classifyKind`, `classifier.parse`, `resolver.resolveTree`) — a future enhancement
 * once stage authors are ready for it. For now, in-flight stages always run to completion before the abort takes
 * effect.
 */
function throwIfAborted(opts?: PipelineOpts): void {
	if (opts?.signal?.aborted) {
		throw opts.signal.reason ?? new DOMException("Pipeline aborted", "AbortError")
	}
}

/** Defensive wrapper: if the classifier throws, return an empty tree rather than abort the pipeline. */
async function safeClassify(
	classifier: AddressClassifier,
	text: string,
	queryShape: QueryShapeLite,
	fst?: FSTMatcherLike,
	normalizeCase?: boolean,
	placetypePair?: PlacetypePairPassthrough
): Promise<AddressTree> {
	try {
		// Postcode regex repair on by default (v0.7 #35, operator-signed). #690 normalizeCase forwards as-is —
		// default-ON at the classifier since #895 (unset runs it; explicit false pins the raw-case parse).
		// Word-consistency heal on by default (2026-07-15): arbitrates intra-word tag disagreement only, with the
		// punctuation-separator + byte-fallback gates — clean win across golden us/fr/adversarial + parity floors.
		// Semantics in neural/word-consistency.ts.
		// placetypePair (#1278): an opaque per-parse prior handle forwarded verbatim — undefined omits it (byte-stable
		// no-prior decode), so the classifier's `opts?.placetypePair ?? cfg.placetypePair` resolution is unchanged when absent.
		return await classifier.parse(text, {
			queryShape,
			fst,
			postcodeRepair: true,
			normalizeCase,
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			...(placetypePair !== undefined ? { placetypePair } : {}),
		})
	} catch {
		return { raw: text, roots: [] }
	}
}

/** Defensive wrapper: a grouper failure returns an empty proposal list rather than abort. */
async function safeGroupPhrases(
	groupPhrases: NonNullable<RuntimePipelineStages["groupPhrases"]>,
	normalized: NormalizedInputLite,
	shape: QueryShapeLite,
	locale: LocaleHint
): Promise<PhraseProposal[]> {
	try {
		return await groupPhrases(normalized, shape, locale)
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// Grouper-audit pass
// ---------------------------------------------------------------------------

const GROUPER_TYPING_PENALTY = 0.55

const PHRASE_KIND_TO_TAG: ReadonlyMap<string, ComponentTag> = new Map([
	["VENUE_PHRASE", "venue"],
	["LOCALITY_PHRASE", "locality"],
	["REGION_ABBREVIATION", "region"],
	["POSTCODE", "postcode"],
	["STREET_PHRASE", "street"],
	["NUMERIC", "house_number"],
])

/**
 * Post-classification audit: for each phrase-grouper proposal whose span is entirely unlabeled (all-O) in the
 * classifier output, inject a provisional node using the grouper's structural hypothesis. This rescues spans the neural
 * model couldn't type — primarily venue text.
 *
 * When `classifierTopK` is supplied (the joint-reconcile path), the audit defers to the classifier's own verdict for
 * the orphaned span: if the classifier confidently typed it as a DIFFERENT component than the phrase kind, we inject
 * the classifier's tag rather than the structural guess. Without this, a reconciler that leaves a street-prefix word
 * like `Via` orphaned (because it picked the single `Trento` street span) would see the audit promote `Via`'s
 * LOCALITY_PHRASE to a spurious `locality` node — burying the real trailing city. The classifier said `street:0.73` for
 * `Via`; trust it (#425).
 */
export function grouperAudit(
	tree: AddressTree,
	proposals: PhraseProposal[],
	text: string,
	classifierTopK?: ClassifierCandidate[]
): AddressTree {
	if (proposals.length === 0) return tree

	const roots = [...tree.roots]

	const allNodes: Array<{ start: number; end: number }> = []
	const collectNodes = (nodes: typeof roots): void => {
		for (const n of nodes) {
			allNodes.push({ start: n.start, end: n.end })

			if (n.children) {
				collectNodes(n.children as typeof roots)
			}
		}
	}
	collectNodes(roots)

	// Index the classifier's single best tag per exact span (start:end) so the audit can defer to it.
	const CLASSIFIER_OVERRIDE_MIN = 0.4
	const bestTagBySpan = new Map<string, { tag: ComponentTag; score: number }>()

	for (const c of classifierTopK ?? []) {
		const k = `${c.span.start}:${c.span.end}`
		const cur = bestTagBySpan.get(k)

		if (!cur || c.score > cur.score) {
			bestTagBySpan.set(k, { tag: c.tag, score: c.score })
		}
	}

	// Tags that may appear AT MOST ONCE per address. On the joint path, the reconciler has already
	// placed the confident locality/region/postcode; a SECOND one injected here is almost always a
	// street-name word the OOD model mistyped ("Via Francesca Nord" → `Francesca`) or an area-line
	// prefix ("LUGAR …" / "URBANIZACION …"). Suppressing the duplicate keeps the real trailing city
	// from being shadowed by an earlier-positioned spurious node in `decodeAsJSON` (#425 residual tail).
	const SINGLETON_TAGS: ReadonlySet<ComponentTag> = new Set<ComponentTag>(["locality", "region", "postcode", "country"])
	const presentSingletons = new Set<ComponentTag>()
	const collectSingletons = (nodes: typeof roots): void => {
		for (const n of nodes) {
			if (SINGLETON_TAGS.has(n.tag)) {
				presentSingletons.add(n.tag)
			}

			if (n.children) {
				collectSingletons(n.children as typeof roots)
			}
		}
	}
	collectSingletons(roots)
	const dedupeSingletons = classifierTopK !== undefined

	// joint path only — argmax stays byte-stable

	for (const proposal of proposals) {
		const phraseTag = PHRASE_KIND_TO_TAG.get(proposal.kindHypothesis)

		if (!phraseTag) continue

		const pStart = proposal.span.start
		const pEnd = pStart + proposal.span.body.length

		const covered = allNodes.some((node) => node.start < pEnd && pStart < node.end)

		if (covered) continue

		// Defer to the classifier when it confidently typed this exact span as something else.
		const classifierVerdict = bestTagBySpan.get(`${proposal.span.start}:${proposal.span.end}`)
		const tag =
			classifierVerdict && classifierVerdict.score >= CLASSIFIER_OVERRIDE_MIN ? classifierVerdict.tag : phraseTag

		// Don't inject a second singleton-tag node when the reconciler already produced one.
		if (dedupeSingletons && SINGLETON_TAGS.has(tag) && presentSingletons.has(tag)) continue

		const provisionalNode: AddressNode = {
			tag,
			value: text.slice(pStart, pEnd),
			start: pStart,
			end: pEnd,
			confidence: proposal.confidence * GROUPER_TYPING_PENALTY,
			children: [],
			source: "grouper-audit",
			sourceID: `grouper:${proposal.kindHypothesis}`,
		}

		roots.push(provisionalNode)

		if (SINGLETON_TAGS.has(tag)) {
			presentSingletons.add(tag)
		}
	}

	roots.sort((a, b) => a.start - b.start)

	return { raw: tree.raw, roots }
}

/** Defensive wrapper: a resolver failure leaves the classifier tree intact. */
async function safeResolve(
	resolver: NonNullable<RuntimePipelineStages["resolver"]>,
	tree: AddressTree,
	opts?: PipelineOpts
): Promise<AddressTree> {
	try {
		return await resolver.resolveTree(tree, opts?.resolveOpts)
	} catch {
		return tree
	}
}
