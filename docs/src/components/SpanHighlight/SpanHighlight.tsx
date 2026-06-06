import type { ResultNode } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

export interface SpanHighlightProps {
	/** The raw text handed to the parser — `nodes[].start/end` index into this. */
	input: string
	/** Flattened parse nodes; only those with numeric `start`/`end` are rendered. */
	nodes: ResultNode[]
}

type Segment = { text: string; node: ResultNode | null }

/** ConfidenceCell's tiers, verbatim — keep these thresholds and the swatch colours in sync. */
function tier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"
	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

/**
 * Render the raw input as a displaCy-style ribbon: each character span the parser tagged is tinted
 * by its confidence (red→amber→green, the same tiering as the table's ConfidenceCell) and labelled
 * with its tag underneath. Delimiters and any unparsed characters fall through as plain text, so a
 * dropped span reads as a literal gap in the colour. Returns null when no node carries offsets
 * (older models, or an all-O parse) — the table alone still tells the story.
 */
export const SpanHighlight: React.FC<SpanHighlightProps> = ({ input, nodes }) => {
	if (!input) return null

	// Keep only well-formed spans that actually index into the input.
	const spans = nodes.filter(
		(n): n is ResultNode & { start: number; end: number } =>
			typeof n.start === "number" &&
			typeof n.end === "number" &&
			n.start >= 0 &&
			n.end > n.start &&
			n.end <= input.length
	)
	if (spans.length === 0) return null

	// Per-character owner = the most specific (shortest) span covering it. Robust to any parent/child
	// span nesting the tree hands us — the leaf always wins, so every character renders once.
	const owner = new Array<number>(input.length).fill(-1)
	for (let i = 0; i < input.length; i++) {
		let best = -1
		let bestLen = Infinity
		for (let s = 0; s < spans.length; s++) {
			const sp = spans[s]
			if (i >= sp.start && i < sp.end && sp.end - sp.start < bestLen) {
				bestLen = sp.end - sp.start
				best = s
			}
		}
		owner[i] = best
	}

	// Coalesce runs of the same owner into segments.
	const segments: Segment[] = []
	let from = 0
	for (let i = 1; i <= input.length; i++) {
		if (i === input.length || owner[i] !== owner[from]) {
			segments.push({ text: input.slice(from, i), node: owner[from] === -1 ? null : spans[owner[from]] })
			from = i
		}
	}

	return (
		<div className={styles.spanHighlight}>
			<div className={styles.legend}>
				<span>confidence</span>
				<span className={`${styles.swatch} ${styles.low}`} /> low
				<span className={`${styles.swatch} ${styles.mid}`} /> mid
				<span className={`${styles.swatch} ${styles.high}`} /> high
			</div>
			<div className={styles.track}>
				{segments.map((seg, i) =>
					seg.node ? (
						<span
							key={i}
							className={`${styles.seg} ${styles[tier(seg.node.confidence)]}`}
							title={`${seg.node.tag}${seg.node.confidence != null ? ` · ${seg.node.confidence.toFixed(2)}` : ""}`}
						>
							<span className={styles.segText}>{seg.text}</span>
							<span className={styles.segTag}>{seg.node.tag}</span>
						</span>
					) : (
						<span key={i} className={styles.gap}>
							{seg.text}
						</span>
					)
				)}
			</div>
		</div>
	)
}
