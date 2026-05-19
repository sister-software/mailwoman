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
import { PARENT_OF } from "./containment.js"
import type { AddressNode, AddressTree, DecoderToken } from "./types.js"

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

function flush(open: OpenSpan | null, raw: string, out: AddressNode[]): null {
	if (!open) return null
	const value = raw.slice(open.start, open.end)
	const confidence = open.confidences.reduce((a, b) => a + b, 0) / open.confidences.length
	out.push({ tag: open.tag, start: open.start, end: open.end, value, confidence, children: [] })
	return null
}

function emitSpans(raw: string, tokens: DecoderToken[]): AddressNode[] {
	const out: AddressNode[] = []
	let open: OpenSpan | null = null

	for (const tok of tokens) {
		const { prefix, tag } = bioParts(tok.label)

		if (prefix === "O") {
			open = flush(open, raw, out)
			continue
		}

		if (prefix === "B" || open === null || open.tag !== tag) {
			open = flush(open, raw, out)
			open = { tag: tag!, start: tok.start, end: tok.end, confidences: [tok.confidence] }
			continue
		}

		// I- continuation of same tag.
		open.end = tok.end
		open.confidences.push(tok.confidence)
	}

	flush(open, raw, out)
	return out
}

function distance(a: AddressNode, b: AddressNode): number {
	if (a.end <= b.start) return b.start - a.end
	if (b.end <= a.start) return a.start - b.end
	return 0
}

function findParent(span: AddressNode, all: AddressNode[]): AddressNode | null {
	const candidates = PARENT_OF[span.tag] ?? []
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
 */
export function buildAddressTree(raw: string, tokens: DecoderToken[]): AddressTree {
	const spans = emitSpans(raw, tokens)
	const roots: AddressNode[] = []

	for (const span of spans) {
		const parent = findParent(span, spans)
		if (parent) parent.children.push(span)
		else roots.push(span)
	}

	sortByStart(roots)
	return { raw, roots }
}
