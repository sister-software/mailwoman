/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   BIO-stream → AddressTree.
 *
 *   Two passes:
 *
 *   1. Span emission — walk the token stream, group `B-X` followed by `I-X*` into one span. Lenient on
 *        hanging `I-X` (treat as new span). Span `value` is sliced from `raw` by [start, end), NOT
 *        concatenated from `piece` — this avoids SentencePiece's synthetic leading-space markers in
 *        the output.
 *   2. Parent attachment — for each span, find the nearest labeled span whose tag is the
 *        highest-priority entry in this span's `PARENT_OF` list. Distance is the tiebreaker only.
 *        Spans with no found parent become roots.
 *
 *   The "nearest" rule (vs "most-recent-prior") is intentional: it makes the decoder robust to source
 *   ordering — e.g. "75004 Paris" attaches postcode to locality even though postcode came first.
 *   Source order is still preserved in the `start`/`end` fields, which the XML serializer exposes
 *   as attributes.
 */

import type { BioLabel, ComponentTag } from "../types/component.js"
import { containmentFor } from "./containment.js"
import type { AddressNode, AddressSystem, AddressTree, DecoderToken } from "./types.js"

/**
 * Optional caller-supplied attribution stamped on every emitted node. The BIO stream comes from a
 * single model, so there's no per-span variation — one source for the whole tree.
 *
 * Phase 4.3 may overlay a resolver-derived attribution per node on top of this baseline.
 */
export interface BuildTreeOpts {
	source?: string
	sourceId?: string
	/**
	 * Addressing system to decode under — selects the containment hierarchy via `containmentFor`.
	 * Stamped onto the returned `AddressTree.system`. Omit for the default Western hierarchy. Today
	 * all systems share one map, so this only records intent + threads the discriminator; it becomes
	 * behavioral when a system-specific map lands (Phase 6 JP). See `containment.ts`.
	 */
	system?: AddressSystem
}

interface OpenSpan {
	tag: ComponentTag
	start: number
	end: number
	confidences: number[]
}

function bioParts(label: BioLabel): { prefix: "B" | "I" | "O"; tag: ComponentTag | null } {
	if (label === "O") return { prefix: "O", tag: null }
	const dash = label.indexOf("-")
	return { prefix: label.slice(0, dash) as "B" | "I", tag: label.slice(dash + 1) as ComponentTag }
}

// Unicode-aware boundary trim: shrink (start, end) past leading/trailing chars that aren't letters
// or numbers. Reason: BIO span boundaries from the model occasionally include a preceding comma+
// space or trailing punctuation token (the "boundary slip" diagnosed in v0.4.0 — see PHASE_2's
// v0.4.0 entry). The model's tag attribution is correct, only the boundary is fuzzy. Trimming
// produces a clean canonical value AND clean start/end offsets so downstream consumers slicing
// raw[start:end] get the same string as node.value.
function trimBoundary(raw: string, start: number, end: number): { start: number; end: number } {
	let s = start
	let e = end
	const isWordChar = (i: number): boolean => /[\p{L}\p{N}]/u.test(raw[i] ?? "")
	while (s < e && !isWordChar(s)) s++
	while (e > s && !isWordChar(e - 1)) e--
	return { start: s, end: e }
}

function flush(open: OpenSpan | null, raw: string, out: AddressNode[], attribution: BuildTreeOpts): null {
	if (!open) return null
	const { start, end } = trimBoundary(raw, open.start, open.end)
	// A span that trims to empty (all-punctuation) is meaningless — drop it. Confidence is moot.
	if (start >= end) return null
	const value = raw.slice(start, end)
	const confidence = open.confidences.reduce((a, b) => a + b, 0) / open.confidences.length
	const node: AddressNode = { tag: open.tag, start, end, value, confidence, children: [] }
	if (attribution.source !== undefined) node.source = attribution.source
	if (attribution.sourceId !== undefined) node.sourceId = attribution.sourceId
	out.push(node)
	return null
}

function emitSpans(raw: string, tokens: DecoderToken[], attribution: BuildTreeOpts): AddressNode[] {
	const out: AddressNode[] = []
	let open: OpenSpan | null = null

	for (const tok of tokens) {
		const { prefix, tag } = bioParts(tok.label)

		if (prefix === "O") {
			open = flush(open, raw, out, attribution)
			continue
		}

		if (prefix === "B" || open === null || open.tag !== tag) {
			open = flush(open, raw, out, attribution)
			open = { tag: tag!, start: tok.start, end: tok.end, confidences: [tok.confidence] }
			continue
		}

		// I- continuation of same tag.
		open.end = tok.end
		open.confidences.push(tok.confidence)
	}

	flush(open, raw, out, attribution)
	return out
}

function distance(a: AddressNode, b: AddressNode): number {
	if (a.end <= b.start) return b.start - a.end
	if (b.end <= a.start) return a.start - b.end
	return 0
}

function findParent(
	span: AddressNode,
	all: AddressNode[],
	parentOf: Partial<Record<ComponentTag, ComponentTag[]>>
): AddressNode | null {
	const candidates = parentOf[span.tag] ?? []
	for (const parentTag of candidates) {
		const matches = all.filter((s) => s !== span && s.tag === parentTag)
		if (matches.length === 0) continue
		return matches.reduce((best, cur) => (distance(cur, span) < distance(best, span) ? cur : best))
	}
	return null
}

function sortByStart(nodes: AddressNode[]): void {
	nodes.sort((a, b) => a.start - b.start)
	for (const n of nodes) sortByStart(n.children)
}

/**
 * Build an `AddressTree` from a raw input string and the token stream produced by the model.
 *
 * @param raw The original input as fed to the tokenizer.
 * @param tokens Model output: one entry per piece with predicted BIO label + confidence.
 * @param opts Optional attribution stamped on every emitted node. Callers in the neural pipeline
 *   pass `{ source: "neural", sourceId: <model-card-version> }` to mark provenance for the XML
 *   serializer's `src` attribute.
 */
export function buildAddressTree(raw: string, tokens: DecoderToken[], opts: BuildTreeOpts = {}): AddressTree {
	const spans = emitSpans(raw, tokens, opts)
	const roots: AddressNode[] = []
	const parentOf = containmentFor(opts.system)

	for (const span of spans) {
		const parent = findParent(span, spans, parentOf)
		if (parent) parent.children.push(span)
		else roots.push(span)
	}

	sortByStart(roots)
	const tree: AddressTree = { raw, roots }
	if (opts.system !== undefined) tree.system = opts.system
	return tree
}
