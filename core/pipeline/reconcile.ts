/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `reconcileSpans` — Stage 5 joint-decoding path.
 *
 *   Today's runtime Stage 5 (in `runtime-pipeline.ts`) just keeps the classifier-emitted spans in
 *   start order. That fallback covers callers who don't yet have top-k inputs from Stages 2.7 / 3 /
 *   6. This file is the **opt-in** joint-decoding path that turns Stage 5 from a sort into a
 *   reconciler: pick the parse tree that maximizes
 *
 *   ```
 *   ∏  phrase_grouper_confidence
 *    × classifier_confidence
 *    × resolver_score
 *    × concordance_bonus(parent_id chain)
 * ```
 *
 *   Closes the kryptonite catalogue (`NY-NY Steakhouse, Houston, TX`, `Paris, Texas`, `Saint
 *   Petersburg, FL`, `Buffalo Buffalo`) where today's argmax-per-stage produces internally-
 *   inconsistent parses that the layer above can't repair.
 *
 *   The implementation is a beam search over candidate slots — each slot is one `(phrase_span,
 *   classifier_tag, resolver_place)` triple. Three knobs prune the cross product: `kSpan` (de-duped
 *   phrase span proposals), `kTag` (classifier tag interpretations per span), and `kResolver`
 *   (resolver candidates per `(span, tag)`). Concordance scoring is incremental — when a slot is
 *   added, we check the new place's `parent_id` chain against the running admin assignment and
 *   adjust the running score before pruning.
 *
 *   The Thread C-s classifier top-k contract is mocked locally for v0.5.0 (see `ClassifierCandidate`
 *   below). The real classifier output adapter ships with `@mailwoman/neural` once Thread C-s
 *   lands; the existing `ResolvedPlace` shape from `@mailwoman/core/resolver` is what backs the
 *   resolver-candidates axis (parent_id chains live there).
 *
 *   See `docs/articles/plan/phases/PHASE_8_v0_5_0_fresh_slate.md` § D for the v0.5.0 context and
 *   `docs/articles/concepts/the-knowledge-ladder.md` § Reconcile for the design rationale.
 */

import type { AddressNode, AddressTree, ComponentTag } from "../decoder/types.js"
import type { ResolvedPlace } from "../resolver/types.js"
import type { PhraseProposal } from "./types.js"

/**
 * One classifier interpretation for one input span. Pins the Thread C-s contract for the reconciler
 * — the real classifier emits this directly once that thread lands. Until then, tests hand-build a
 * list of these to simulate top-k output.
 *
 * The classifier may emit multiple candidates for the same span (different tag hypotheses); the
 * reconciler treats those as the top-k tag axis. Candidates whose `span` does not exactly match a
 * phrase proposal's span are ignored — the phrase grouper is the boundary-discovery authority.
 */
export interface ClassifierCandidate {
	span: { start: number; end: number }
	tag: ComponentTag
	/** Calibrated confidence in [0, 1]. */
	score: number
}

/**
 * Resolver lookup for the (span, tag) axis. In production wraps a `ResolverBackend` (Stage 6); in
 * tests an in-memory table built per fixture. Returned candidates must already be sorted descending
 * by score — the reconciler takes the top `kResolver` as-is.
 */
export interface ResolverCandidatesLookup {
	candidatesFor(span: { start: number; end: number }, tag: ComponentTag): ReadonlyArray<ResolvedPlace>
}

/**
 * Parent-chain lookup for concordance scoring. WOF SQLite is the source of truth in production
 * (Stage 6); tests pass a `Map`-backed mock. Returns the place's ancestors (order unimportant — the
 * reconciler only checks membership).
 */
export interface ParentChainLookup {
	parentsOf(place: ResolvedPlace): ReadonlyArray<ResolvedPlace>
}

export interface ReconcileInputs {
	/** Raw input text — used to materialize `value` strings on the resulting tree. */
	raw: string
	phraseProposals: ReadonlyArray<PhraseProposal>
	/** Sorted descending by score. May be empty (returns an empty tree). */
	classifierTopK: ReadonlyArray<ClassifierCandidate>
	resolverCandidates?: ResolverCandidatesLookup
	parentChain?: ParentChainLookup
	opts?: ReconcileOpts
}

export interface ReconcileOpts {
	/** Top-k phrase span proposals retained per (start, end) — default 3. */
	kSpan?: number
	/** Top-k classifier tag interpretations retained per span — default 3. */
	kTag?: number
	/** Top-k resolver candidates retained per (span, tag) — default 5. */
	kResolver?: number
	/**
	 * Concordance bonus multiplier. 1.0 weights chain-consistency equal to one classifier-score
	 * factor; lower values trust the classifier more, higher values trust the gazetteer more. Default
	 * 1.0.
	 */
	concordanceWeight?: number
	/** Beam width during search — default 16. */
	beamWidth?: number
	/** Runner-up parses returned alongside the winner — default 3. */
	runnersUp?: number
}

export interface ScoreBreakdown {
	phrase: number
	classifier: number
	resolver: number
	concordance: number
	/** Composite multiplicative score in real space, [0, ∞). */
	total: number
}

export interface ParseTree {
	tree: AddressTree
	/** Softmaxed confidence in [0, 1] over the finalized beam. */
	confidence: number
	runnersUp: AddressTree[]
	scoreBreakdown: ScoreBreakdown
}

const DEFAULTS = {
	kSpan: 3,
	kTag: 3,
	kResolver: 5,
	concordanceWeight: 1.0,
	beamWidth: 16,
	runnersUp: 3,
}

/**
 * Log-space bonus per accepted slot. Counterweight for the multiplicative penalty inherent in
 * "score = ∏ confidences": each factor in [0, 1] strictly lowers the running score, which would
 * otherwise make the empty parse always win. log(2.5) — a slot whose product of factors exceeds
 * 1/2.5 = 0.4 is worth including; below that, the search prefers to skip.
 *
 * The choice of 2.5 is a tuning constant, not a free parameter we expose — exposing it would invite
 * callers to disable inclusion entirely (defeating the purpose of the reconciler) and the sensible
 * range is narrow. Lives here rather than `ReconcileOpts` for that reason.
 */
const INCLUSION_LOG_BONUS = Math.log(2.5)

/**
 * Admin levels from coarse to fine. Concordance scoring walks pairs (parent_level, child_level) and
 * checks the child's parent_id chain for the parent's place id.
 */
const ADMIN_LEVELS: ReadonlyArray<ComponentTag> = ["country", "region", "locality", "dependent_locality"]
const ADMIN_LEVEL_SET = new Set<ComponentTag>(ADMIN_LEVELS)

interface SlotChoice {
	span: PhraseProposal["span"]
	phraseConf: number
	tag: ComponentTag
	classifierScore: number
	place: ResolvedPlace | null
	resolverScore: number
}

interface Beam {
	assignments: SlotChoice[]
	/** Log-space score combining phrase × classifier × resolver × concordance (running). */
	logScore: number
	/** Cached last-end so we can extend left-to-right without re-scanning assignments. */
	lastEnd: number
}

/**
 * Joint-decode the best parse tree from Stage 2.7 phrase proposals, Stage 3 classifier top-k, and
 * Stage 6 resolver candidates. See file header for the scoring formula.
 *
 * The result tree's roots are the winning `(span, tag, place)` triples in source order. Each node's
 * `placeId`, `lat`, `lon` come from the chosen resolver candidate; `confidence` reflects the per-
 * factor score for that slot. `runnersUp` are the next-best parses for caller inspection.
 *
 * Empty `classifierTopK` short-circuits to an empty tree at confidence 0 — no joint decode is
 * possible without tag interpretations. Callers without top-k should use the runtime-pipeline
 * fallback (which keeps classifier-emitted spans sorted by start).
 */
export function reconcileSpans(inputs: ReconcileInputs): ParseTree {
	const opts = { ...DEFAULTS, ...inputs.opts }

	const slots = buildSlots(inputs, opts)
	if (slots.length === 0) {
		return emptyParseTree(inputs.raw)
	}

	// Beam search over left-to-right slot inclusion. Each slot is either accepted (if non-
	// overlapping with the beam's claimed range) or skipped. Beam pruning keeps the top
	// `beamWidth` by running log-score.
	const slotsByStart = slots.slice().sort((a, b) => a.span.start - b.span.start)
	let beams: Beam[] = [{ assignments: [], logScore: 0, lastEnd: -1 }]

	for (const slot of slotsByStart) {
		const next: Beam[] = []
		for (const beam of beams) {
			next.push(beam)
			if (slot.span.start >= beam.lastEnd) {
				const concordanceDelta = concordanceDeltaFor(beam.assignments, slot, inputs, opts)
				if (concordanceDelta === Number.NEGATIVE_INFINITY) continue
				const slotLog =
					logSafe(slot.phraseConf) +
					logSafe(slot.classifierScore) +
					logSafe(slot.resolverScore) +
					concordanceDelta +
					INCLUSION_LOG_BONUS
				next.push({
					assignments: [...beam.assignments, slot],
					logScore: beam.logScore + slotLog,
					lastEnd: slot.span.end,
				})
			}
		}
		next.sort((a, b) => b.logScore - a.logScore)
		beams = next.slice(0, opts.beamWidth)
	}

	beams.sort((a, b) => b.logScore - a.logScore)
	// Drop the empty beam if there's at least one non-empty competitor (the empty beam scores 0,
	// which would otherwise dominate when all real candidates have very low log-scores).
	const populated = beams.filter((b) => b.assignments.length > 0)
	const ordered = populated.length > 0 ? populated : beams

	const top = ordered[0]!
	const runners = ordered.slice(1, 1 + opts.runnersUp)

	const trees = ordered.map((b) => buildTree(b, inputs.raw))
	const confidences = softmax(ordered.map((b) => b.logScore))

	return {
		tree: trees[0]!,
		confidence: confidences[0]!,
		runnersUp: runners.map((_, i) => trees[i + 1]!),
		scoreBreakdown: breakdownFor(top, inputs, opts),
	}
}

/**
 * Build the candidate slot set: dedupe phrase proposals by (start, end), join with classifier top-k
 * tag candidates, join with resolver places per (span, tag).
 *
 * Spans with no classifier candidate are dropped — the reconciler cannot tag them. Spans with no
 * resolver candidate still survive; the resolver score defaults to 1 (neutral) and the slot's place
 * is null (won't contribute to concordance).
 */
function buildSlots(inputs: ReconcileInputs, opts: Required<ReconcileOpts>): SlotChoice[] {
	const bySpanKey = new Map<string, PhraseProposal>()
	for (const p of inputs.phraseProposals) {
		const k = spanKey(p.span.start, p.span.end)
		const cur = bySpanKey.get(k)
		if (!cur || p.confidence > cur.confidence) {
			bySpanKey.set(k, p)
		}
	}
	// `kSpan` limits the number of overlapping proposals anchored at each start position — NOT a
	// global cap on phrase proposals. Two phrases at different starts (e.g. `Houston` at 18 +
	// `TX` at 27) are independent candidates and both must survive `kSpan = 3`. Without this per-
	// start grouping, a low-confidence-but-correct proposal (e.g. `Houston` @ 0.65) is dropped
	// just because the input has many higher-confidence proposals elsewhere.
	const byStart = new Map<number, PhraseProposal[]>()
	for (const p of bySpanKey.values()) {
		const arr = byStart.get(p.span.start) ?? []
		arr.push(p)
		byStart.set(p.span.start, arr)
	}
	const spans: PhraseProposal[] = []
	for (const arr of byStart.values()) {
		spans.push(...topN(arr, opts.kSpan, (p) => p.confidence))
	}

	const tagsBySpan = new Map<string, ClassifierCandidate[]>()
	for (const c of inputs.classifierTopK) {
		const k = spanKey(c.span.start, c.span.end)
		const arr = tagsBySpan.get(k) ?? []
		arr.push(c)
		tagsBySpan.set(k, arr)
	}

	const slots: SlotChoice[] = []
	for (const phrase of spans) {
		const key = spanKey(phrase.span.start, phrase.span.end)
		const tagCandidates = topN(tagsBySpan.get(key) ?? [], opts.kTag, (c) => c.score)
		for (const tagC of tagCandidates) {
			const places = inputs.resolverCandidates
				? inputs.resolverCandidates.candidatesFor(tagC.span, tagC.tag).slice(0, opts.kResolver)
				: []
			if (places.length === 0) {
				slots.push({
					span: phrase.span,
					phraseConf: phrase.confidence,
					tag: tagC.tag,
					classifierScore: tagC.score,
					place: null,
					resolverScore: 1,
				})
				continue
			}
			for (const place of places) {
				slots.push({
					span: phrase.span,
					phraseConf: phrase.confidence,
					tag: tagC.tag,
					classifierScore: tagC.score,
					place,
					resolverScore: normalizeResolverScore(place.score),
				})
			}
		}
	}
	return slots
}

/**
 * Concordance delta for adding `slot` to an existing beam. Returns the log-space contribution to
 * add to the beam's running score, or `-Infinity` if the slot introduces a hard contradiction
 * (would be admissible into the beam's admin chain but explicitly disagrees).
 *
 * Behavior at the boundaries:
 *
 * - Slot has no place or is non-admin → 0 (no chain contribution).
 * - No admin neighbors yet → 0 (nothing to agree with).
 * - Admin chain agrees → `+ concordanceWeight × log(1 + match_ratio)`.
 * - Some admin pairs cannot be verified (missing parents) → 0 contribution per neutral pair.
 * - Admin chain has any explicit contradiction → `-Infinity` (hard veto).
 */
function concordanceDeltaFor(
	existing: SlotChoice[],
	candidate: SlotChoice,
	inputs: ReconcileInputs,
	opts: Required<ReconcileOpts>
): number {
	if (!candidate.place || !ADMIN_LEVEL_SET.has(candidate.tag)) return 0
	const chainOf = inputs.parentChain
	if (!chainOf) return 0
	const candIdx = ADMIN_LEVELS.indexOf(candidate.tag)
	let matches = 0
	let neutrals = 0
	let pairs = 0
	for (const prior of existing) {
		if (!prior.place || !ADMIN_LEVEL_SET.has(prior.tag)) continue
		const priorIdx = ADMIN_LEVELS.indexOf(prior.tag)
		const child = priorIdx > candIdx ? prior : candidate
		const parent = priorIdx > candIdx ? candidate : prior
		if (child === parent) continue
		const chain = chainOf.parentsOf(child.place!)
		pairs++
		if (chain.length === 0) {
			neutrals++
			continue
		}
		const hit = chain.some((p) => idsEqual(p.id, parent.place!.id))
		if (hit) {
			matches++
		} else {
			return Number.NEGATIVE_INFINITY
		}
	}
	if (pairs === 0) return 0
	const matchRatio = matches / pairs
	// Linear in matchRatio so a fully-consistent chain contributes exactly `+concordanceWeight`
	// log-space — the briefing's "+1 for fully consistent" reading. Matches contribute
	// proportionally; neutrals (no chain data) don't penalize.
	return opts.concordanceWeight * matchRatio
}

function idsEqual(a: number | string, b: number | string): boolean {
	return String(a) === String(b)
}

/**
 * Compute the per-factor breakdown for the winning beam. Independently of the search's `logScore`
 * (which carries the inclusion-bonus prior), the breakdown surfaces the bare `phrase × classifier ×
 * resolver × concordance` product so callers can introspect why a tree won.
 */
function breakdownFor(beam: Beam, inputs: ReconcileInputs, opts: Required<ReconcileOpts>): ScoreBreakdown {
	let phrase = 1
	let classifier = 1
	let resolver = 1
	for (const a of beam.assignments) {
		phrase *= Math.max(a.phraseConf, 0)
		classifier *= Math.max(a.classifierScore, 0)
		resolver *= Math.max(a.resolverScore, 0)
	}
	const concordanceLog = totalConcordanceLog(beam.assignments, inputs, opts)
	const concordance = Math.exp(concordanceLog)
	const total = phrase * classifier * resolver * concordance
	return { phrase, classifier, resolver, concordance, total }
}

/**
 * Recompute the joint concordance contribution for the entire assignment list (vs the incremental
 * `concordanceDeltaFor` used during search). Used by the breakdown.
 */
function totalConcordanceLog(
	assignments: SlotChoice[],
	inputs: ReconcileInputs,
	opts: Required<ReconcileOpts>
): number {
	if (!inputs.parentChain) return 0
	let acc = 0
	for (let i = 0; i < assignments.length; i++) {
		const delta = concordanceDeltaFor(assignments.slice(0, i), assignments[i]!, inputs, opts)
		if (delta === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY
		acc += delta
	}
	return acc
}

function buildTree(beam: Beam, raw: string): AddressTree {
	const roots: AddressNode[] = beam.assignments
		.slice()
		.sort((a, b) => a.span.start - b.span.start)
		.map((slot) => ({
			tag: slot.tag,
			value: raw.slice(slot.span.start, slot.span.end),
			start: slot.span.start,
			end: slot.span.end,
			confidence: slot.classifierScore * slot.phraseConf,
			children: [],
			source: "reconcile",
			sourceId: "reconcile:stage-5-joint",
			...(slot.place
				? {
						lat: slot.place.lat,
						lon: slot.place.lon,
						placeId: `${placeIdPrefix(slot.place)}:${slot.place.id}`,
					}
				: {}),
		}))
	return { raw, roots }
}

function emptyParseTree(raw: string): ParseTree {
	return {
		tree: { raw, roots: [] },
		confidence: 0,
		runnersUp: [],
		scoreBreakdown: { phrase: 0, classifier: 0, resolver: 0, concordance: 1, total: 0 },
	}
}

function placeIdPrefix(place: ResolvedPlace): string {
	// Mirror the convention used by @mailwoman/resolver-wof-sqlite (`wof:<id>`). Resolver
	// backends that don't carry an implicit vendor in `id` get a neutral `place:` prefix.
	return typeof place.id === "number" ? "wof" : "place"
}

function spanKey(start: number, end: number): string {
	return `${start}:${end}`
}

function topN<T>(items: ReadonlyArray<T>, n: number, key: (t: T) => number): T[] {
	return items
		.slice()
		.sort((a, b) => key(b) - key(a))
		.slice(0, n)
}

function logSafe(x: number): number {
	return x > 0 ? Math.log(x) : -50
}

function normalizeResolverScore(score: number): number {
	// Resolver score scale is implementation-defined; clamp to (0, 1] for the multiplicative
	// combiner. A backend that returns 0 still counts as a candidate (e.g. a partial match) but
	// contributes a tiny log-factor.
	if (!Number.isFinite(score) || score <= 0) return 0.01
	if (score > 1) return 1
	return score
}

function softmax(scores: number[]): number[] {
	if (scores.length === 0) return []
	const max = Math.max(...scores)
	const exps = scores.map((s) => Math.exp(s - max))
	const sum = exps.reduce((a, b) => a + b, 0)
	return exps.map((e) => e / sum)
}
