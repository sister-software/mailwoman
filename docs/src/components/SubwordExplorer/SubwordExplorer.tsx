/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SubwordExplorer — educational word-level tokenization explorer that shows how Mailwoman's
 *   pipeline stages process each word token. Complements BIOHighlight by adding per-stage
 *   annotations (query shape, kind, phrase groups, classified spans) for each word of the input.
 *   Designed to work inside a DemoEmbedProvider context.
 *
 *   Since direct SentencePiece access isn't available via the DemoEmbed context, this component shows
 *   word-level tokenization derived from the pipeline result (classified spans with start/end
 *   offsets). Each pipeline stage's contribution is annotated per word where applicable.
 */

import type React from "react"
import type { KindResult, ResultNode, StageTiming } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubwordExplorerProps {
	/** The raw text handed to the parser — `nodes[].start/end` index into this. */
	input: string
	/** Flattened parse nodes; only those with numeric `start`/`end` are rendered. */
	nodes: ResultNode[]
	/** The parse tree (for phrase-group extraction via intermediate grouping nodes). */
	tree?: unknown
	/** Stage 2.5 kind classifier result. */
	kindResult?: KindResult
	/** Per-stage timing breakdown. */
	timing?: StageTiming
}

// ---------------------------------------------------------------------------
// Word tokenization (matches BIOHighlight's approach)
// ---------------------------------------------------------------------------

interface WordToken {
	/** The word text as it appears in the input. */
	text: string
	/** Leading whitespace before this word. */
	whitespace: string
	/** Start offset in the input string. */
	start: number
	/** End offset in the input string. */
	end: number
}

/** Tokenize the raw input into words, preserving leading whitespace for each token. */
function tokenizeWords(input: string): WordToken[] {
	const words: WordToken[] = []
	let i = 0
	while (i < input.length) {
		let ws = ""
		while (i < input.length && /\s/.test(input[i])) {
			ws += input[i]
			i++
		}
		if (i >= input.length) break
		const start = i
		while (i < input.length && !/\s/.test(input[i])) {
			i++
		}
		words.push({ text: input.slice(start, i), start, end: i, whitespace: ws })
	}
	return words
}

// ---------------------------------------------------------------------------
// Span + phrase-group assignment
// ---------------------------------------------------------------------------

interface SpanInfo {
	tag: string
	confidence?: number
	start: number
	end: number
	value?: unknown
}

interface AnnotatedWord {
	word: WordToken
	/** The most specific span covering this word (same shortest-span owner as BIOHighlight). */
	span: SpanInfo | null
	/** BIO label (B-X, I-X, or O). */
	label: string
	/** Tag this label refers to (e.g. "street", "locality"). */
	tag: string | null
	/** Phrase group index — adjacent words of the same tag form a phrase group. */
	phraseGroup: number
	/** Whether this word starts a new phrase group. */
	phraseGroupStart: boolean
}

/**
 * Assign each word to its most specific covering span (shortest-span owner) and derive BIO labels +
 * phrase groups.
 */
function annotateWords(words: WordToken[], nodes: ResultNode[]): AnnotatedWord[] {
	// Filter to well-formed spans.
	const spans: SpanInfo[] = nodes
		.filter(
			(n): n is ResultNode & { start: number; end: number } =>
				typeof n.start === "number" && typeof n.end === "number" && n.start >= 0 && n.end > n.start
		)
		.map((n) => ({ tag: n.tag, confidence: n.confidence, start: n.start, end: n.end, value: n.value }))

	// Per-word: index of the shortest covering span.
	const owner: number[] = new Array(words.length).fill(-1)
	for (let w = 0; w < words.length; w++) {
		const wStart = words[w].start
		const wEnd = words[w].end
		let best = -1
		let bestLen = Infinity
		for (let s = 0; s < spans.length; s++) {
			const sp = spans[s]
			if (wStart < sp.end && wEnd > sp.start && sp.end - sp.start < bestLen) {
				bestLen = sp.end - sp.start
				best = s
			}
		}
		owner[w] = best
	}

	// Assign phrase groups: consecutive words with the same span index form a group.
	let nextGroup = 0
	const result: AnnotatedWord[] = []
	for (let w = 0; w < words.length; w++) {
		const spanIdx = owner[w]
		const prevSpanIdx = w > 0 ? owner[w - 1] : -1
		const span = spanIdx === -1 ? null : spans[spanIdx]

		// BIO label assignment.
		let label: string
		let tag: string | null
		if (!span) {
			label = "O"
			tag = null
		} else {
			const isFirst = spanIdx !== prevSpanIdx
			label = isFirst ? `B-${span.tag}` : `I-${span.tag}`
			tag = span.tag
		}

		// Phrase group: same span index = same phrase group.
		let phraseGroup: number
		let phraseGroupStart: boolean
		if (spanIdx === -1) {
			// O words get their own isolated group.
			phraseGroup = nextGroup++
			phraseGroupStart = true
		} else if (spanIdx !== prevSpanIdx) {
			// New span starts a new phrase group.
			phraseGroup = nextGroup++
			phraseGroupStart = true
		} else {
			phraseGroup = result[w - 1].phraseGroup
			phraseGroupStart = false
		}

		result.push({ word: words[w], span, label, tag, phraseGroup, phraseGroupStart })
	}
	return result
}

// ---------------------------------------------------------------------------
// Confidence tier (mirrors SpanHighlight / ResultPanel)
// ---------------------------------------------------------------------------

function tier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"
	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

// ---------------------------------------------------------------------------
// Pipeline stage definitions (for the flow diagram + legend)
// ---------------------------------------------------------------------------

interface PipelineStage {
	key: string
	label: string
	description: string
	icon: string
	color: string
}

const PIPELINE_STAGES: PipelineStage[] = [
	{
		key: "tokenize",
		label: "Tokenize",
		description: "The raw input is split into word tokens on whitespace boundaries. Each word becomes a column below.",
		icon: "🔤",
		color: "#6b7280",
	},
	{
		key: "query_shape",
		label: "Query Shape",
		description:
			"Analyzes the structure of the input: is it a street address, a bare postcode, a locality name, or something else? This shapes downstream decisions.",
		icon: "🔍",
		color: "#8b5cf6",
	},
	{
		key: "kind",
		label: "Kind",
		description:
			"Classifies the address kind (full, structured, postcode_only, etc.) based on query shape + input structure. Determines which components to expect.",
		icon: "🏷️",
		color: "#f59e0b",
	},
	{
		key: "phrase_groups",
		label: "Phrase Groups",
		description:
			"Adjacent tokens that form a multi-word address component (e.g. 'Pennsylvania Ave') are merged into phrase groups before classification.",
		icon: "🔗",
		color: "#06b6d4",
	},
	{
		key: "bio_classify",
		label: "BIO Classify",
		description:
			"The neural model (ONNX runtime) assigns BIO labels to each token: B-X (begin), I-X (inside), or O (outside). These are the color-coded labels below each word.",
		icon: "🧠",
		color: "#3b82f6",
	},
	{
		key: "tree_decode",
		label: "Tree Decode",
		description:
			"The joint-reconcile decoder resolves BIO labels into a hierarchical address tree, handling multi-word localities, Romance street prefixes, and correct house-number boundaries.",
		icon: "🌳",
		color: "#22c55e",
	},
]

// ---------------------------------------------------------------------------
// Pipeline flow diagram (compact, horizontal)
// ---------------------------------------------------------------------------

const PipelineFlow: React.FC = () => (
	<div className={styles.pipelineFlow}>
		{PIPELINE_STAGES.map((stage, i) => (
			<span key={stage.key} className={styles.flowStep}>
				{i > 0 ? <span className={styles.flowArrow}>→</span> : null}
				<span className={styles.flowPill} style={{ borderColor: stage.color }} title={stage.description}>
					<span className={styles.flowIcon}>{stage.icon}</span>
					<span className={styles.flowLabel}>{stage.label}</span>
				</span>
			</span>
		))}
	</div>
)

// ---------------------------------------------------------------------------
// Stage detail panel (expandable per-stage descriptions)
// ---------------------------------------------------------------------------

const StageDetails: React.FC = () => (
	<details className={styles.stageDetails}>
		<summary className={styles.stageDetailsSummary}>Pipeline stage descriptions</summary>
		<dl className={styles.stageDetailsList}>
			{PIPELINE_STAGES.map((stage) => (
				<div key={stage.key} className={styles.stageDetailItem}>
					<dt style={{ borderLeftColor: stage.color }}>
						{stage.icon} {stage.label}
					</dt>
					<dd>{stage.description}</dd>
				</div>
			))}
		</dl>
	</details>
)

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const SubwordExplorer: React.FC<SubwordExplorerProps> = ({ input, nodes, kindResult, timing }) => {
	if (!input) return null

	// Keep only well-formed spans.
	const validNodes = nodes.filter(
		(n): n is ResultNode & { start: number; end: number } =>
			typeof n.start === "number" &&
			typeof n.end === "number" &&
			n.start >= 0 &&
			n.end > n.start &&
			n.end <= input.length
	)

	// Always render word tokens even if no spans — the tokenizer itself is a pipeline stage.
	const words = tokenizeWords(input)
	const annotated = annotateWords(words, validNodes)
	const hasSpans = validNodes.length > 0

	return (
		<div className={styles.subwordExplorer}>
			{/* Pipeline flow diagram */}
			<PipelineFlow />

			{/* Stage descriptions (collapsible) */}
			<StageDetails />

			{/* Kind badge inline */}
			{kindResult ? (
				<div className={styles.kindContext}>
					<span className={styles.kindContextLabel}>Detected kind:</span>{" "}
					<code className={styles.kindContextValue}>{kindResult.kind}</code>
					<span className={styles.kindContextConf}>({(kindResult.confidence * 100).toFixed(0)}%)</span>
				</div>
			) : null}

			{/* Timing inline */}
			{timing ? (
				<div className={styles.timingContext}>
					<span className={styles.timingLabel}>Pipeline timing:</span>{" "}
					<span className={styles.timingValue}>
						Shape {timing.shape.toFixed(1)}ms · Classify {timing.classify.toFixed(1)}ms
						{timing.resolve != null ? ` · Resolve ${timing.resolve.toFixed(1)}ms` : ""}
					</span>
				</div>
			) : null}

			{/* Word token grid */}
			<div className={styles.tokenGrid}>
				<div className={styles.tokenGridHeader}>
					<span className={styles.headerCol}>word</span>
					<span className={styles.headerCol}>BIO label</span>
					<span className={styles.headerCol}>confidence</span>
				</div>
				<div className={styles.tokenRows}>
					{annotated.map((aw, i) => {
						const spanTier = aw.span ? tier(aw.span.confidence) : "none"
						const labelClass = aw.label === "O" ? styles.bioO : aw.label.startsWith("B-") ? styles.bioB : styles.bioI

						return (
							<div
								key={i}
								className={`${styles.tokenRow} ${aw.phraseGroupStart ? styles.phraseGroupStart : ""}`}
								title={
									aw.span
										? [
												`Word: "${aw.word.text}"`,
												`Tag: ${aw.span.tag}`,
												`Value: ${aw.span.value ?? "—"}`,
												`Confidence: ${aw.span.confidence?.toFixed(3) ?? "—"}`,
												`Label: ${aw.label}`,
												`Phrase group: #${aw.phraseGroup}`,
											].join("\n")
										: `Word: "${aw.word.text}"\nLabel: O (unclassified)`
								}
							>
								{/* Word column */}
								<span className={styles.wordCell}>
									{aw.word.whitespace ? <span className={styles.ws}>{aw.word.whitespace}</span> : null}
									<span className={`${styles.wordText} ${aw.span ? styles[`conf_${spanTier}`] : ""}`}>
										{aw.word.text}
									</span>
								</span>

								{/* BIO label column */}
								<span className={`${styles.labelCell} ${labelClass}`}>{aw.label}</span>

								{/* Confidence column */}
								<span className={styles.confCell}>
									{aw.span?.confidence != null ? (
										<span className={`${styles.confDot} ${styles[`confDot_${spanTier}`]}`} />
									) : (
										<span className={styles.confNone}>—</span>
									)}
									{aw.span?.confidence != null ? (
										<span className={styles.confValue}>{(aw.span.confidence * 100).toFixed(0)}%</span>
									) : null}
								</span>
							</div>
						)
					})}
				</div>
			</div>

			{/* Summary footer */}
			<div className={styles.summary}>
				<span className={styles.summaryItem}>
					<strong>{words.length}</strong> word token{words.length !== 1 ? "s" : ""}
				</span>
				{hasSpans ? (
					<>
						<span className={styles.summarySep}>·</span>
						<span className={styles.summaryItem}>
							<strong>{validNodes.length}</strong> classified span{validNodes.length !== 1 ? "s" : ""}
						</span>
						<span className={styles.summarySep}>·</span>
						<span className={styles.summaryItem}>
							<strong>{new Set(annotated.filter((a) => a.span).map((a) => a.phraseGroup)).size}</strong> phrase group
							{new Set(annotated.filter((a) => a.span).map((a) => a.phraseGroup)).size !== 1 ? "s" : ""}
						</span>
					</>
				) : null}
			</div>

			{!hasSpans ? (
				<p className={styles.noSpansNote}>
					No classified spans available — this model version may not emit character offsets. The word tokens above show
					the raw tokenizer output without BIO labels.
				</p>
			) : null}
		</div>
	)
}
