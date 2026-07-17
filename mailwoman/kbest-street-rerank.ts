/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #727 stage-2 phase 4c — the k-best name-evidence rerank, wired end-to-end.
 *
 *   Composes the three merged pieces into one production entry point: the span head's k-best
 *   segmentations (`decodeSegmentationsKBest`), the measured pick policy (`pickByStreetEvidence`,
 *   the G1/G2 v2 rule), and an injected street-name index (`StreetLocalityEvidence`, FR = BAN).
 *
 *   MEASURED (v3.10.1 8k substrate, 2026-07-18, evidence-gated street-splice vs the argmax baseline
 *   production actually runs): golden us/fr exact **0.000 regression, every tag unchanged**; FR
 *   fragment street **+16.9pp** (argmax 0.673 → 0.841), 273 fixes / 3 breaks (bare-street +18pp,
 *   date-name +40.7pp). Receipt: `docs/articles/evals/2026-07-18-phase4c-wiring.md`.
 *
 *   THREE THINGS MAKE IT GOLDEN-SAFE:
 *   1. ANCHOR GATE. The rerank fires ONLY on an anchorless fragment — the class it was measured on.
 *      If the argmax parse already carries a `country` or `region`, the input is structured and the
 *      model is reliable; a name-index collision then does damage (it steals a token the model
 *      correctly labeled — "France, Creuse, …" → the FR street "France" overrides the country; "Best
 *      Rd, VT" → a US street reranks against the FR index). Skipping anchored inputs is the primary
 *      cross-locale + collateral fix (full-pipeline golden, scored: net 0 exact, |Δ| < 0.3pp/tag).
 *   2. STREET-SPLICE, not tree-replace. The span head is a street-boundary specialist — its full
 *      segmentation decodes locality/region/postcode far worse than the BIO argmax head (replacing
 *      the whole tree cost golden fr −35pp). So the winning segmentation's street tokens are spliced
 *      into the ARGMAX tree; argmax owns every other tag.
 *   3. POSITIVE-EVIDENCE GATE. The splice fires only for a street the atlas CONFIRMS exists. On a
 *      clean address the argmax street is already right + confirmed → the splice is a no-op; on a
 *      fragment the argmax street is wrong/absent and the confirmed segmentation street replaces it.
 *      An unconfirmed street NEVER overrides the model — the model owns every call the atlas can't
 *      confirm wrong. This is why golden holds to noise while FR fragments move +17.3pp.
 *
 *   BYTE-STABLE fallback: a model with no span scores (every pre-v3 bundle) returns exactly
 *   `buildAddressTree(trace.text, trace.tokens)` — the same tree `classifier.parse(text)` produces.
 *
 *   The evidence backend is INJECTED (mirroring `PlaceLookup`), so this stays engine-agnostic: FR
 *   today, US TIGER / NO Kartverket next, each behind the same interface with no code change here.
 */

import { type BIOLabel, buildAddressTree, type DecoderToken } from "@mailwoman/core/decoder"
import type { AddressTree } from "@mailwoman/core/decoder"
import { BIO_LABELS } from "@mailwoman/core/types"
import {
	decodeSegmentationsKBest,
	type NeuralAddressClassifier,
	type NeuralParseTrace,
	type ParseOpts,
	type SegmentationHypothesis,
	type SemiCRFTransitions,
} from "@mailwoman/neural"
import {
	foldStreetSurface,
	pickByStreetEvidence,
	type StreetCandidate,
	type StreetEvidenceScope,
	type StreetLocalityEvidence,
} from "@mailwoman/resolver"

/** The segment-type strings that make up a street surface (the STREET family). */
const STREET_SEGMENT_TYPES: ReadonlySet<string> = new Set([
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
])

const BIO_LABEL_SET: ReadonlySet<string> = new Set(BIO_LABELS)

/** Admin anchors whose presence in the argmax parse means the input is STRUCTURED — the rerank stands down (see below). */
const ANCHOR_TAGS: ReadonlySet<string> = new Set(["country", "region"])

export interface StreetRerankOpts {
	/** K-best decode depth. Default 5 (the measured board depth). */
	k?: number
	/** G2 margin cap forwarded to {@link pickByStreetEvidence}. Default 2.5 (the measured value). */
	marginCap?: number
	/** Locality/postcode scope for the evidence probe (fragments usually carry none). */
	scope?: StreetEvidenceScope
	/** Parse options forwarded to `classifier.traceParse` (production config: postcodeRepair, queryShape, …). */
	parseOpts?: ParseOpts
}

export interface StreetRerankResult {
	/** The parse tree: the argmax tree, with the winning street spliced in when the atlas confirms it. */
	tree: AddressTree
	/** True when name evidence moved the pick off the model's rank-1 (a loggable rank-2-beats-rank-1 correction). */
	moved: boolean
	/** Index of the winning hypothesis in the k-best list (0 = model rank-1). */
	rank: number
	/** The winning street surface (raw), for logging + the training-signal capture. */
	streetSurface: string
}

/** Slice the street surface (raw text) of a segmentation hypothesis from the trace's per-token char offsets. */
function hypothesisStreetSurface(
	hyp: SegmentationHypothesis,
	trace: NeuralParseTrace,
	grammar: SemiCRFTransitions
): string {
	const parts = hyp.segments
		.filter((s) => STREET_SEGMENT_TYPES.has(grammar.segmentTypes[s.typeID] ?? ""))
		.sort((a, b) => a.start - b.start)
		.map((s) => {
			const first = trace.tokens[s.start]
			const last = trace.tokens[s.start + s.length - 1]

			return first && last ? trace.text.slice(first.start, last.end).trim() : ""
		})
		.filter(Boolean)

	return parts.join(" ")
}

/**
 * SPLICE the winning hypothesis's STREET span into the argmax tree — override only the tokens the segmentation assigns
 * to the street family, leaving every other token's argmax label untouched.
 *
 * Why not rebuild the whole tree from the segmentation: the span head is a street-boundary specialist and decodes
 * locality/region/postcode far worse than the full BIO argmax head (golden fr locality 0.855→0.506, us exact −6.4pp, fr
 * exact −35pp measured 2026-07-18). Replacing the tree would trade the +street win for a locality/postcode collapse.
 * The rerank's whole value is on the STREET tag, so it touches only the street tokens — argmax owns the rest. This also
 * keeps the intervention minimal + positive-evidence-shaped: the only thing the atlas is allowed to change is the
 * street.
 */
function spliceStreetTree(
	hyp: SegmentationHypothesis,
	trace: NeuralParseTrace,
	grammar: SemiCRFTransitions
): AddressTree {
	const tokens: DecoderToken[] = trace.tokens.map((t) => ({ ...t }))
	// The set of token indices the argmax path already labels street-family — cleared before re-installing the
	// segmentation's street, so a shrunk/moved street span doesn't leave orphaned argmax street tokens behind.
	const argmaxStreetIdx = new Set<number>()

	for (let i = 0; i < tokens.length; i++) {
		const tag = tokens[i]!.label.replace(/^[BI]-/, "")

		if (STREET_SEGMENT_TYPES.has(tag)) {
			argmaxStreetIdx.add(i)
		}
	}

	const streetSegs = hyp.segments.filter((s) => STREET_SEGMENT_TYPES.has(grammar.segmentTypes[s.typeID] ?? ""))

	// No street in the winning hypothesis → nothing to splice; the argmax tree stands.
	if (streetSegs.length === 0) {
		return buildAddressTree(trace.text, tokens)
	}

	for (const seg of streetSegs) {
		// Install the segmentation's street labels on this segment's covered tokens.
		const type = grammar.segmentTypes[seg.typeID]!

		for (let j = 0; j < seg.length; j++) {
			const idx = seg.start + j
			const tok = tokens[idx]

			if (!tok) continue
			const label = `${j === 0 ? "B" : "I"}-${type}`
			tok.label = (BIO_LABEL_SET.has(label) ? label : "O") as BIOLabel
			argmaxStreetIdx.delete(idx)
		}
	}

	// Any argmax street token NOT covered by the new street span is now stale → drop to O (it was part of the street
	// the argmax path over-extended; the reranked span is authoritative for the street).
	for (const idx of argmaxStreetIdx) {
		tokens[idx]!.label = "O"
	}

	return buildAddressTree(trace.text, tokens)
}

/**
 * Parse `text` and rerank the span head's k-best segmentations on street-name evidence. Returns the winning tree +
 * whether evidence moved the pick. Falls back to the plain argmax tree (byte-stable) when the model exports no span
 * scores or the evidence keeps rank-1.
 *
 * @param evidence The injected street-name index (FR = `SQLiteStreetNameLookup` over BAN street-centroids).
 * @param grammar The segment-transition grammar from the weights bundle's `semi-crf-transitions.json`.
 */
export async function rerankByStreetEvidence(
	classifier: NeuralAddressClassifier,
	text: string,
	evidence: StreetLocalityEvidence,
	grammar: SemiCRFTransitions,
	opts: StreetRerankOpts = {}
): Promise<StreetRerankResult> {
	const trace = await classifier.traceParse(text, opts.parseOpts)

	// No span head → the k-best surface doesn't exist. Byte-stable fallback to the argmax tree.
	if (!trace.spanScores) {
		return {
			tree: buildAddressTree(trace.text, trace.tokens),
			moved: false,
			rank: 0,
			streetSurface: "",
		}
	}

	// ANCHOR GATE (2026-07-18, the full-pipeline collateral fix): the rerank arbitrates a street ONLY on an ANCHORLESS
	// fragment — the class it was measured on. When the argmax parse already carries a country or region anchor, the
	// model is on structured input where it is reliable, and a name-index collision does damage: it STEALS a token the
	// model correctly labeled country/region ("France, Creuse, …" → the FR street "France" overrides country; "Best Rd,
	// VT" → the US street reranks against the FR index). Skipping anchored inputs fixes both by construction and keeps
	// every fragment-board class (bare street ± house number carries no admin anchor). Scored against gold, this holds
	// golden exact to noise (us 2180→2180, fr 1308→1308, |Δ| < 0.3pp/tag) while the FR fragment board moves +17.3pp.
	// Postcode is NOT an anchor: adding it cut a little US collateral but mislabels 4-digit years as postcode, killing
	// the date-name board (0.550→0.215) — too blunt for a real gain, so the anchor set stays country+region only.
	if (trace.tokens.some((t) => ANCHOR_TAGS.has(t.label.replace(/^[BI]-/, "")))) {
		return { tree: buildAddressTree(trace.text, trace.tokens), moved: false, rank: 0, streetSurface: "" }
	}

	const hyps = decodeSegmentationsKBest(trace.spanScores, trace.tokens.length, grammar, opts.k ?? 5)

	if (hyps.length === 0) {
		return { tree: buildAddressTree(trace.text, trace.tokens), moved: false, rank: 0, streetSurface: "" }
	}

	const candidates: Array<StreetCandidate<SegmentationHypothesis>> = hyps.map((h) => ({
		streetSurface: hypothesisStreetSurface(h, trace, grammar),
		score: h.score,
		payload: h,
	}))

	const pick = pickByStreetEvidence(candidates, evidence, {
		...(opts.marginCap !== undefined ? { marginCap: opts.marginCap } : {}),
		...(opts.scope ? { scope: opts.scope } : {}),
	})

	// POSITIVE-EVIDENCE GATE on the splice: only override the argmax tree's street with a street the atlas CONFIRMS
	// exists. This is the same principle as the pick itself — the model owns every call the atlas can't confirm wrong.
	// Rationale (measured 2026-07-18): always-splicing cost golden fr street −2.7pp (the span head over/under-extends
	// the street on clean multi-component inputs, and the full BIO head is better there); gating on "argmax has no
	// street" was too coarse (kept argmax's WRONG street on fragments). Splicing only an atlas-confirmed street holds
	// golden to noise (segmentation street == argmax street on clean, both confirmed → no-op) AND keeps the fragment
	// win (argmax street wrong/absent, segmentation street confirmed → spliced). An unconfirmed street never overrides.
	const confirmed =
		pick.candidate.streetSurface !== "" && evidence.hasStreetName(pick.candidate.streetSurface, opts.scope)
	const tree = confirmed
		? spliceStreetTree(pick.candidate.payload!, trace, grammar)
		: buildAddressTree(trace.text, trace.tokens)

	return { tree, moved: pick.moved, rank: pick.index, streetSurface: pick.candidate.streetSurface }
}

export { foldStreetSurface }
