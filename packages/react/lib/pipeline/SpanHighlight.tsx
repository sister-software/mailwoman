/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `SpanHighlight` — a displaCy-style span ribbon over the raw input: each tagged span is a column with the text on
 *   top, tinted by its confidence tier, and the tag beneath. Gaps (delimiters, unparsed characters) fall through as
 *   plain text, so a dropped span is visible as a literal break in the colour.
 */

import type { ParsedComponent } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"

import { confidenceTierOrMid } from "#common/confidence-tiers"
import { shortestSpanOwners } from "#common/text-tokens"

export interface SpanHighlightProps {
	/**
	 * The raw text handed to the parser — `nodes[].start/end` index into this.
	 */
	input: string
	/**
	 * Flattened parse nodes; only those with numeric `start`/`end` are rendered.
	 */
	nodes: ParsedComponent[]
}

interface Segment {
	text: string
	node: ParsedComponent | null
}

type Span = ParsedComponent & { start: number; end: number }

export function SpanHighlight({ input, nodes }: SpanHighlightProps): ReactNode {
	if (!input) return null

	// Keep only well-formed spans that index into the input.
	const spans = nodes.filter(
		(n): n is Span =>
			typeof n.start === "number" &&
			typeof n.end === "number" &&
			n.start >= 0 &&
			n.end > n.start &&
			n.end <= input.length
	)

	if (!spans.length) return null

	// Per-character owner: the most specific (shortest) span covering it, the same rule the word-level panels apply
	// per word. The leaf always wins whatever nesting the tree hands over, so every character renders once.
	const characters = Array.from({ length: input.length }, (_, i) => ({ start: i, end: i + 1 }))
	const owner = shortestSpanOwners(characters, spans)

	// Coalesce runs of the same owner into segments.
	const segments: Segment[] = []
	let from = 0

	for (let i = 1; i <= input.length; i++) {
		if (i === input.length || owner[i] !== owner[from]) {
			const ownerIndex = owner[from] ?? -1

			segments.push({ text: input.slice(from, i), node: ownerIndex === -1 ? null : (spans[ownerIndex] ?? null) })

			from = i
		}
	}

	return (
		<div className="mw-spans">
			<div className="mw-spans__legend">
				<span>confidence</span>
				<span className="mw-spans__swatch mw-spans__swatch--low" /> low
				<span className="mw-spans__swatch mw-spans__swatch--mid" /> mid
				<span className="mw-spans__swatch mw-spans__swatch--high" /> high
			</div>
			<div className="mw-spans__track">
				{segments.map((seg, i) =>
					seg.node ? (
						<span
							key={i}
							className={`mw-spans__seg mw-spans__seg--${confidenceTierOrMid(seg.node.confidence)}`}
							title={`${seg.node.tag}${seg.node.confidence != null ? ` · ${seg.node.confidence.toFixed(2)}` : ""}`}
						>
							<span className="mw-spans__text">{seg.text}</span>
							<span className="mw-spans__tag">{seg.node.tag}</span>
						</span>
					) : (
						<span key={i} className="mw-spans__gap">
							{seg.text}
						</span>
					)
				)}
			</div>
		</div>
	)
}
