/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The k-best name-evidence rerank: composes the span head's k-best segmentations (`decodeSegmentationsKBest`),
 * the pick policy (`pickByStreetEvidence`), and an injected street-name index (`StreetLocalityEvidence`).
 *
 * Three properties make it golden-safe: the rerank fires only on an anchorless fragment, the class it was
 * measured on. The winning segmentation's street tokens are spliced into the argmax tree rather than replacing
 * it, because the span head decodes locality/region/postcode far worse than the BIO argmax head. And the splice
 * fires only for a street the atlas confirms exists, so an unconfirmed street never overrides the model. A model
 * with no span scores returns exactly `buildAddressTree(trace.text, trace.tokens)`, byte-stable.
 *
 * The evidence backend is injected, so this stays engine-agnostic.
 */

import type { BIOLabel } from "@mailwoman/codex/component"
import { bareBIOTag, BIO_LABELS } from "@mailwoman/codex/component"
import { buildAddressTree, type DecoderToken, type AddressTree } from "@mailwoman/core/decoder"
import {
	decodeSegmentationsKBest,
	type NeuralAddressClassifier,
	type NeuralParseTrace,
	type ParseOpts,
	type SegmentationHypothesis,
	type SemiCRFTransitions,
} from "@mailwoman/neural"
import {
	pickByStreetEvidence,
	type StreetCandidate,
	type StreetEvidenceScope,
	type StreetLocalityEvidence,
} from "@mailwoman/resolver"

const STREET_SEGMENT_TYPES: ReadonlySet<string> = new Set([
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
])

const BIO_LABEL_SET: ReadonlySet<string> = new Set(BIO_LABELS)

/**
 * Admin anchors whose presence in the argmax parse means the input is structured, so the rerank stands down.
 */
const ANCHOR_TAGS: ReadonlySet<string> = new Set(["country", "region"])

export interface StreetRerankOpts {
	/**
	 * K-best decode depth. @default 5
	 */
	k?: number
	/**
	 * G2 margin cap forwarded to {@link pickByStreetEvidence}. @default 2.5
	 */
	marginCap?: number
	/**
	 * Locality/postcode scope for the evidence probe.
	 * Fragments usually carry none.
	 */
	scope?: StreetEvidenceScope
	/**
	 * Parse options forwarded to `classifier.traceParse` (production config: postcodeRepair, queryShape, …).
	 */
	parseOpts?: ParseOpts
}

export interface StreetRerankResult {
	/**
	 * The parse tree: the argmax tree, with the winning street spliced in when the atlas confirms it.
	 */
	tree: AddressTree
	/**
	 * True when name evidence moved the pick off the model's rank-1
	 * (a loggable rank-2-beats-rank-1 correction).
	 */
	moved: boolean
	/**
	 * Index of the winning hypothesis in the k-best list (0 = model rank-1).
	 */
	rank: number
	/**
	 * The winning street surface (raw), for logging and the training-signal capture.
	 */
	streetSurface: string
}

/**
 * Extract the street surface (raw text) of a segmentation hypothesis from the
 * trace's per-token char offsets.
 */
function hypothesisStreetSurface(
	hyp: SegmentationHypothesis,
	trace: NeuralParseTrace,
	grammar: SemiCRFTransitions
): string {
	const parts = hyp.segments
		.filter((s) => STREET_SEGMENT_TYPES.has(grammar.segmentTypes[s.typeID] ?? ""))
		.toSorted((a, b) => a.start - b.start)
		.map((s) => {
			const first = trace.tokens[s.start]
			const last = trace.tokens[s.start + s.length - 1]

			return first && last ? trace.text.slice(first.start, last.end).trim() : ""
		})
		.filter((part) => part.length)

	return parts.join(" ")
}

/**
 * Splice the winning hypothesis's street span into the argmax tree, overriding only the tokens the
 * segmentation assigns to the street family and leaving every other token's argmax label untouched.
 *
 * The span head is a street-boundary specialist and decodes locality/region/postcode
 * far worse than the full BIO argmax head, so rebuilding the whole tree would replace
 * the correctly decoded street boundary with a locality/postcode collapse.
 */
function spliceStreetTree(
	hyp: SegmentationHypothesis,
	trace: NeuralParseTrace,
	grammar: SemiCRFTransitions
): AddressTree {
	const tokens: DecoderToken[] = trace.tokens.map((t) => ({ ...t }))
	// Argmax street-family token indices, cleared as the segmentation's street is installed
	// so a shrunk or moved span does not leave orphaned argmax street tokens behind.
	const argmaxStreetIdx = new Set<number>()

	for (let i = 0; i < tokens.length; i++) {
		const tag = bareBIOTag(tokens[i]!.label)

		if (STREET_SEGMENT_TYPES.has(tag)) {
			argmaxStreetIdx.add(i)
		}
	}

	const streetSegs = hyp.segments.filter((s) => STREET_SEGMENT_TYPES.has(grammar.segmentTypes[s.typeID] ?? ""))

	if (!streetSegs.length) {
		return buildAddressTree(trace.text, tokens)
	}

	for (const seg of streetSegs) {
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

	// An argmax street token the new span does not cover is stale and drops to O:
	// the reranked span is authoritative for the street.
	for (const idx of argmaxStreetIdx) {
		tokens[idx]!.label = "O"
	}

	return buildAddressTree(trace.text, tokens)
}

/**
 * Parse `text` and rerank the span head's k-best segmentations on street-name evidence.
 *
 * @param evidence The injected street-name index.
 * @param grammar The segment-transition grammar from the weights bundle's `semi-crf-transitions.json`.
 *
 * @returns The winning tree and whether evidence moved the pick, falling back to the plain
 * argmax tree when the model exports no span scores or the evidence keeps rank-1.
 */
export async function rerankByStreetEvidence(
	// Only `traceParse` is called; `Pick` says so, and a test double is then an object rather than an assertion.
	classifier: Pick<NeuralAddressClassifier, "traceParse">,
	text: string,
	evidence: StreetLocalityEvidence,
	grammar: SemiCRFTransitions,
	opts: StreetRerankOpts = {}
): Promise<StreetRerankResult> {
	const trace = await classifier.traceParse(text, opts.parseOpts)

	if (!trace.spanScores) {
		return {
			tree: buildAddressTree(trace.text, trace.tokens),
			moved: false,
			rank: 0,
			streetSurface: "",
		}
	}

	// The rerank arbitrates a street only on an anchorless fragment, the class it was
	// measured on: with a country or region anchor the model is on structured input
	// and a name-index collision steals a correct token.
	// Postcode is not an anchor, because treating a 4-digit year as one kills the date-name board.
	if (trace.tokens.some((t) => ANCHOR_TAGS.has(bareBIOTag(t.label)))) {
		return { tree: buildAddressTree(trace.text, trace.tokens), moved: false, rank: 0, streetSurface: "" }
	}

	const hyps = decodeSegmentationsKBest(trace.spanScores, trace.tokens.length, grammar, opts.k ?? 5)

	if (!hyps.length) {
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

	// Only an atlas-confirmed street may override the argmax tree's street. the
	// model owns every call the atlas cannot confirm wrong, and on a clean address
	// the two streets agree so the splice is a no-op.
	const confirmed =
		pick.candidate.streetSurface !== "" && evidence.hasStreetName(pick.candidate.streetSurface, opts.scope)

	const tree = confirmed
		? spliceStreetTree(pick.candidate.payload!, trace, grammar)
		: buildAddressTree(trace.text, trace.tokens)

	return { tree, moved: pick.moved, rank: pick.index, streetSurface: pick.candidate.streetSurface }
}
