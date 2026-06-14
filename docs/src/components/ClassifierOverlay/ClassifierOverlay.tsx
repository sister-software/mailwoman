/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ClassifierOverlay — shows per-component classification origin. Maps each parsed address component
 *   to the pipeline stage(s) that contributed to its assignment. Complements BIOHighlight
 *   (word-level labeling) and SubwordExplorer (per-stage token annotations) by adding the
 *   provenance story: which stages touched which components.
 *
 *   Two modes:
 *
 *   - **static**: A legend/explainer showing all pipeline stages, their colors, and what role they play
 *       in classification.
 *   - **dynamic**: A per-component table with color-coded origin badges showing exactly which stage(s)
 *       influenced each parsed component.
 */

import type { ResultNode } from "../../shared/resources.tsx"

import styles from "./styles.module.css"

// ---------------------------------------------------------------------------
// Stage taxonomy
// ---------------------------------------------------------------------------

interface StageDef {
	key: string
	label: string
	icon: string
	badgeColor: string
	textColor: string
	description: string
	/**
	 * `AddressNode.source` values that map to this stage. When a node's `source` matches one of
	 * these, this stage contributed to that node.
	 */
	sourceMatches: string[]
	/** True when a node can carry this stage's badge AND a different source (displaced classifier). */
	coexists?: boolean
	/** Pipeline-wide flag — not a per-node source. */
	isPipelineFlag?: boolean
}

const STAGES: StageDef[] = [
	{
		key: "query_shape",
		label: "Query Shape",
		icon: "🔍",
		badgeColor: "#8b5cf6",
		textColor: "#fff",
		description:
			"Structural analysis — identifies the format of the input: is it a street address, a bare postcode, a locality name, or something else? Shapes downstream decisions about which components to expect.",
		sourceMatches: ["query-shape"],
	},
	{
		key: "kind",
		label: "Kind",
		icon: "🏷️",
		badgeColor: "#f59e0b",
		textColor: "#1a1a1a",
		description:
			"Address kind classifier — labels the input as structured_address, postcode_only, locality_only, intersection, etc. Determines the expected component set before classification begins.",
		sourceMatches: [],
		isPipelineFlag: true,
	},
	{
		key: "fst_prior",
		label: "FST Prior",
		icon: "🗺️",
		badgeColor: "#ec4899",
		textColor: "#fff",
		description:
			"Gazetteer-based emission biases from a pre-built finite-state transducer. Biases the neural model toward known US place names (~94K entries), helping it recognize rare localities and postcode patterns.",
		sourceMatches: [],
		isPipelineFlag: true,
	},
	{
		key: "rule_classifier",
		label: "Rule",
		icon: "📋",
		badgeColor: "#f97316",
		textColor: "#fff",
		description:
			"Pattern-based classifiers — regex, dictionary lookups, and heuristics that assign tags deterministically. Fast and interpretable; handles postcodes, region abbreviations, and numeric house numbers.",
		sourceMatches: ["rule"],
	},
	{
		key: "neural_classifier",
		label: "Neural",
		icon: "🧠",
		badgeColor: "#3b82f6",
		textColor: "#fff",
		description:
			"Deep learning model (ONNX runtime) that assigns BIO labels to each token using learned sequence patterns. Handles multi-word localities, complex street names, and non-standard formatting.",
		sourceMatches: ["neural"],
	},
	{
		key: "crf_reconcile",
		label: "Reconcile",
		icon: "🔗",
		badgeColor: "#22c55e",
		textColor: "#1a1a1a",
		description:
			"Joint-reconcile decoder — resolves classifier proposals and phrase boundaries into a coherent address tree. Uses CRF/Viterbi to fix multi-word entity splitting (the 'Saint Petersburg' problem).",
		sourceMatches: ["reconcile"],
	},
	{
		key: "wof_resolver",
		label: "WOF",
		icon: "🌐",
		badgeColor: "#6366f1",
		textColor: "#fff",
		description:
			"Who's On First gazetteer — resolves place names to canonical WOF IDs with coordinates and admin hierarchies. Can override the classifier tag when the gazetteer has higher-confidence type info.",
		sourceMatches: ["resolver"],
		coexists: true,
	},
	{
		key: "grouper_audit",
		label: "Grouper",
		icon: "🔬",
		badgeColor: "#14b8a6",
		textColor: "#fff",
		description:
			"Phrase grouper audit nodes — surface the phrase boundary proposals the grouper emitted. For debugging phrase grouping decisions (visible only when audit mode is on).",
		sourceMatches: ["grouper-audit"],
	},
]

/** Fast lookup: source string → StageDef */
const SOURCE_TO_STAGE: Map<string, StageDef> = new Map()
for (const stage of STAGES) {
	for (const src of stage.sourceMatches) {
		SOURCE_TO_STAGE.set(src, stage)
	}
}

// ---------------------------------------------------------------------------
// Tree-flattening with source preservation
// ---------------------------------------------------------------------------

interface SourceNode {
	tag: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
	source?: string
	sourceId?: string
	/** Displaced classifier source when the resolver won (from metadata). */
	displacedSource?: string
	displacedSourceId?: string
}

interface TreeNodeLike {
	tag?: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
	source?: string
	sourceId?: string
	metadata?: Record<string, unknown>
	children?: unknown[]
}

/**
 * Flatten the address tree preserving source provenance. Mirrors `flattenTree` from demo-helpers
 * but preserves `source` / `sourceId` and extracts displaced classifier info from `metadata` when
 * available.
 */
function flattenTreeWithSource(tree: unknown): SourceNode[] {
	const out: SourceNode[] = []
	const roots = (tree as { roots?: unknown[] } | null | undefined)?.roots ?? []
	const stack = [...(roots as TreeNodeLike[])]
	while (stack.length) {
		const n = stack.pop()!
		if (typeof n.tag === "string") {
			const displacedSource =
				typeof n.metadata?.classifier_source === "string" ? n.metadata.classifier_source : undefined
			const displacedSourceId =
				typeof n.metadata?.classifier_source_id === "string" ? n.metadata.classifier_source_id : undefined
			out.push({
				tag: n.tag,
				value: n.value,
				confidence: n.confidence,
				start: n.start,
				end: n.end,
				source: n.source,
				sourceId: n.sourceId,
				displacedSource,
				displacedSourceId,
			})
		}
		if (Array.isArray(n.children)) {
			for (const c of n.children) {
				stack.push(c as TreeNodeLike)
			}
		}
	}
	return out.reverse()
}

// ---------------------------------------------------------------------------
// Stage resolution for a node
// ---------------------------------------------------------------------------

interface StageContribution {
	stage: StageDef
	/** When true, this is a displaced classifier — the resolver overrode it. */
	displaced?: boolean
}

/** Determine which pipeline stages contributed to a node. */
function resolveStages(node: SourceNode): StageContribution[] {
	const contributions: StageContribution[] = []

	// Primary source
	const primaryStage = node.source ? SOURCE_TO_STAGE.get(node.source) : undefined
	if (primaryStage) {
		contributions.push({ stage: primaryStage })
	}

	// Displaced classifier (when resolver wins)
	if (node.displacedSource) {
		const displacedStage = SOURCE_TO_STAGE.get(node.displacedSource)
		if (displacedStage && displacedStage !== primaryStage) {
			contributions.push({ stage: displacedStage, displaced: true })
		}
	}

	return contributions
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ClassifierOverlayProps {
	/** The parse tree with source provenance on nodes (AddressTree). */
	tree: unknown
	/** Flattened nodes for display ordering and cross-reference. */
	nodes: ResultNode[]
	/** Whether the FST gazetteer matcher was active for this parse. */
	fstActive?: boolean
	/** Display mode. Default: "dynamic". */
	mode?: "static" | "dynamic"
}

// ---------------------------------------------------------------------------
// Static legend
// ---------------------------------------------------------------------------

const StaticLegend: React.FC<{ fstActive?: boolean }> = ({ fstActive }) => (
	<div className={styles.staticLegend}>
		<p className={styles.legendIntro}>
			Mailwoman&apos;s pipeline processes each address through multiple classification stages. Each parsed component
			below carries origin badges showing which stages contributed to its assignment.
		</p>

		<div className={styles.stageGrid}>
			{STAGES.map((stage) => {
				// Dim FST when not active
				const dimmed = stage.key === "fst_prior" && !fstActive
				return (
					<div
						key={stage.key}
						className={`${styles.stageCard} ${dimmed ? styles.stageCardDimmed : ""}`}
						style={{ borderLeftColor: stage.badgeColor }}
					>
						<div className={styles.stageCardHeader}>
							<span className={styles.stageBadge} style={{ background: stage.badgeColor, color: stage.textColor }}>
								{stage.icon} {stage.label}
							</span>
							{dimmed ? <span className={styles.inactiveTag}>inactive</span> : null}
						</div>
						<p className={styles.stageCardDesc}>{stage.description}</p>
						{stage.sourceMatches.length > 0 ? (
							<div className={styles.stageCardSources}>
								<span className={styles.sourcesLabel}>Node source:</span>
								{stage.sourceMatches.map((s) => (
									<code key={s} className={styles.sourceCode}>
										{s}
									</code>
								))}
							</div>
						) : stage.isPipelineFlag ? (
							<div className={styles.stageCardSources}>
								<span className={styles.sourcesLabel}>Pipeline-level flag</span>
							</div>
						) : null}
					</div>
				)
			})}
		</div>

		<div className={styles.legendFlow}>
			<strong>Pipeline flow:</strong>{" "}
			{STAGES.filter((s) => !s.isPipelineFlag || s.key === "kind" || s.key === "fst_prior").map((s, i) => (
				<span key={s.key}>
					{i > 0 ? <span className={styles.flowArrow}> → </span> : null}
					<span className={styles.flowStage} style={{ color: s.badgeColor }}>
						{s.icon} {s.label}
					</span>
				</span>
			))}
		</div>
	</div>
)

// ---------------------------------------------------------------------------
// Confidence tier
// ---------------------------------------------------------------------------

function tier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"
	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

// ---------------------------------------------------------------------------
// Dynamic per-component table
// ---------------------------------------------------------------------------

const DynamicOverlay: React.FC<{ tree: unknown; nodes: ResultNode[]; fstActive: boolean }> = ({
	tree,
	nodes,
	fstActive,
}) => {
	const sourceNodes = flattenTreeWithSource(tree)

	// Cross-reference source nodes with display nodes by tag + start/end
	const enriched: Array<ResultNode & { sourceNode?: SourceNode }> = nodes.map((n, i) => {
		// Match by start/end when both have offsets, otherwise by tag + value + index proximity
		const match =
			sourceNodes.find((sn) => sn.tag === n.tag && sn.start === n.start && sn.end === n.end) ??
			sourceNodes.find((sn) => sn.tag === n.tag && String(sn.value ?? "") === String(n.value ?? "")) ??
			sourceNodes[i]
		return { ...n, sourceNode: match && match.tag === n.tag ? match : undefined }
	})

	const hasAnySource = enriched.some((n) => n.sourceNode?.source)

	return (
		<div className={styles.dynamicOverlay}>
			{!hasAnySource ? (
				<p className={styles.noSourceNote}>
					No classifier provenance data available for this parse. Source tracking requires a recent model version
					(v0.3.0+) with Phase 4.1 provenance threading enabled.
				</p>
			) : null}

			<table className={styles.componentTable}>
				<thead>
					<tr>
						<th>tag</th>
						<th>value</th>
						<th>confidence</th>
						<th>origin</th>
					</tr>
				</thead>
				<tbody>
					{enriched.map((n, i) => {
						const contributions = n.sourceNode ? resolveStages(n.sourceNode) : []
						return (
							<tr key={i}>
								<td>
									<code className={styles.tagCode}>{n.tag}</code>
								</td>
								<td className={styles.valueCell}>{String(n.value ?? "")}</td>
								<td>
									{n.confidence != null ? (
										<span className={`${styles.confBadge} ${styles[`conf_${tier(n.confidence)}`]}`}>
											{n.confidence.toFixed(2)}
										</span>
									) : (
										<span className={styles.confDash}>—</span>
									)}
								</td>
								<td className={styles.originCell}>
									{contributions.length === 0 ? (
										<span className={styles.unknownOrigin}>unknown</span>
									) : (
										contributions.map((c, ci) => (
											<span
												key={ci}
												className={`${styles.originBadge} ${c.displaced ? styles.originDisplaced : ""}`}
												style={{ background: c.stage.badgeColor, color: c.stage.textColor }}
												title={
													c.displaced
														? `Originally classified by ${c.stage.label}, overridden by resolver`
														: c.stage.description
												}
											>
												{c.stage.icon} {c.stage.label}
												{c.displaced ? <span className={styles.displacedMark}> ↰</span> : null}
											</span>
										))
									)}
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>

			{/* FST pipeline flag — shown when active but not per-node */}
			{fstActive ? (
				<div className={styles.pipelineFlags}>
					<span className={styles.flagLabel}>Pipeline flags:</span>
					<span
						className={styles.originBadge}
						style={{ background: "#ec4899", color: "#fff" }}
						title={STAGES.find((s) => s.key === "fst_prior")!.description}
					>
						🗺️ FST active
					</span>
				</div>
			) : null}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export const ClassifierOverlay: React.FC<ClassifierOverlayProps> = ({
	tree,
	nodes,
	fstActive = false,
	mode = "dynamic",
}) => {
	if (mode === "static") {
		return <StaticLegend fstActive={fstActive} />
	}

	if (!tree || nodes.length === 0) {
		return (
			<div className={styles.empty}>
				<p>Parse an address to see classifier origin information.</p>
			</div>
		)
	}

	return <DynamicOverlay tree={tree} nodes={nodes} fstActive={fstActive} />
}
