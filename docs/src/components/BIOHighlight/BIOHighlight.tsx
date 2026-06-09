/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   BIOHighlight — word-level BIO label breakdown from a parse tree. Maps each word of the input to
 *   its BIO label (B-X, I-X, O) using the pipeline's span output. Complements SpanHighlight
 *   (character-level confidence ribbon) by showing the discrete BIO tagging the neural model emits
 *   per word.
 */

import type { ResultNode } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

export interface BIOHighlightProps {
	/** The raw text handed to the parser — `nodes[].start/end` index into this. */
	input: string
	/** Flattened parse nodes; only those with numeric `start`/`end` are rendered. */
	nodes: ResultNode[]
}

interface BIOWord {
	/** The word text as it appears in the input. */
	text: string
	/** Leading whitespace before this word. */
	whitespace: string
	/** BIO label for this word. */
	label: string
	/** The tag this label refers to (e.g. "street", "locality", "house_number"). */
	tag: string | null
}

/** Tokenize the raw input into words, preserving leading whitespace for each token. */
function tokenizeWords(input: string): Array<{ text: string; start: number; end: number; whitespace: string }> {
	const words: Array<{ text: string; start: number; end: number; whitespace: string }> = []
	let i = 0
	while (i < input.length) {
		// Skip leading whitespace for this word.
		let ws = ""
		while (i < input.length && /\s/.test(input[i])) {
			ws += input[i]
			i++
		}
		if (i >= input.length) break

		// Collect the word (non-whitespace run).
		const start = i
		while (i < input.length && !/\s/.test(input[i])) {
			i++
		}
		words.push({ text: input.slice(start, i), start, end: i, whitespace: ws })
	}
	return words
}

/**
 * Assign BIO labels to each word based on span coverage.
 *
 * For each word we find the shortest covering span (same per-character shortest-span owner
 * algorithm SpanHighlight uses). The first word of each span gets B-{tag}; subsequent words of the
 * same span get I-{tag}. Words with no covering span get O.
 */
function assignBIOLabels(
	words: ReturnType<typeof tokenizeWords>,
	spans: Array<ResultNode & { start: number; end: number }>
): BIOWord[] {
	// Per-word: index of the shortest covering span.
	const owner: number[] = new Array(words.length).fill(-1)
	for (let w = 0; w < words.length; w++) {
		const wStart = words[w].start
		const wEnd = words[w].end
		let best = -1
		let bestLen = Infinity
		for (let s = 0; s < spans.length; s++) {
			const sp = spans[s]
			// The word is covered if any part of it falls within the span.
			if (wStart < sp.end && wEnd > sp.start && sp.end - sp.start < bestLen) {
				bestLen = sp.end - sp.start
				best = s
			}
		}
		owner[w] = best
	}

	// Assign BIO labels.
	const result: BIOWord[] = []
	for (let w = 0; w < words.length; w++) {
		const spanIdx = owner[w]
		if (spanIdx === -1) {
			result.push({ text: words[w].text, whitespace: words[w].whitespace, label: "O", tag: null })
			continue
		}
		const span = spans[spanIdx]
		// Check if this is the first word of this span (B) or continuation (I).
		const isFirst = w === 0 || owner[w - 1] !== spanIdx
		const prefix = isFirst ? "B" : "I"
		result.push({ text: words[w].text, whitespace: words[w].whitespace, label: `${prefix}-${span.tag}`, tag: span.tag })
	}
	return result
}

/**
 * Render the raw input as a word-level BIO label breakdown.
 *
 * Each word is shown with its BIO label underneath:
 *
 * - B-X labels in green (beginning of an address component)
 * - I-X labels in blue (inside an address component)
 * - O labels in gray (outside any component)
 *
 * Returns null when no node carries offsets — the SpanHighlight can still tell the story.
 */
export const BIOHighlight: React.FC<BIOHighlightProps> = ({ input, nodes }) => {
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

	const words = tokenizeWords(input)
	const bioWords = assignBIOLabels(words, spans)

	return (
		<div className={styles.bioHighlight}>
			<div className={styles.legend}>
				<span className={`${styles.dot} ${styles.b}`} /> B-X (begin)
				<span className={`${styles.dot} ${styles.i}`} /> I-X (inside)
				<span className={`${styles.dot} ${styles.o}`} /> O (outside)
			</div>
			<div className={styles.track}>
				{bioWords.map((w, i) => {
					const tierClass = w.label.startsWith("B-")
						? styles.bioB
						: w.label.startsWith("I-")
							? styles.bioI
							: styles.bioO
					return (
						<span key={i} className={styles.wordCol} title={w.label}>
							{w.whitespace ? <span className={styles.ws}>{w.whitespace}</span> : null}
							<span className={`${styles.word} ${tierClass}`}>{w.text}</span>
							<span className={styles.label}>{w.label}</span>
						</span>
					)
				})}
			</div>
		</div>
	)
}
