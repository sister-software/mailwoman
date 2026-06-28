import styles from "./styles.module.css"

/**
 * The slice of the decoder's AddressNode the demo renders. `children` carries the containment nesting.
 */
interface TreeNode {
	tag?: string
	value?: unknown
	confidence?: number
	children?: TreeNode[]
}

export interface TreeViewProps {
	/** The parser's `AddressTree` (`result.tree`) — we read `.roots` and recurse `.children`. */
	tree: unknown
}

/** ConfidenceCell's tiers, verbatim. */
function tier(confidence?: number): "high" | "mid" | "low" {
	if (confidence == null) return "mid"

	return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "mid" : "low"
}

function renderNode(node: TreeNode, path: string): React.ReactNode {
	if (typeof node.tag !== "string") return null
	const kids = Array.isArray(node.children) ? node.children : []

	return (
		<li key={path} className={styles.node}>
			<span className={styles.row}>
				<span className={`${styles.tag} ${styles[tier(node.confidence)]}`}>{node.tag}</span>
				{node.value != null && String(node.value) !== "" ? (
					<span className={styles.value}>{String(node.value)}</span>
				) : null}
				{typeof node.confidence === "number" ? <span className={styles.conf}>{node.confidence.toFixed(2)}</span> : null}
			</span>
			{kids.length ? <ul className={styles.children}>{kids.map((c, i) => renderNode(c, `${path}.${i}`))}</ul> : null}
		</li>
	)
}

/**
 * The parse as a containment tree — `region ⊃ locality ⊃ {street ⊃ house_number, postcode}` — the nesting the flat
 * component table throws away. Each node shows its tag (tinted by confidence, same red→amber→green as the table),
 * value, and score. Reads the decoder's `AddressTree.roots`/`children` directly; renders null when the tree is empty so
 * nothing shows for an unparseable input.
 */
export const TreeView: React.FC<TreeViewProps> = ({ tree }) => {
	const roots = (tree as { roots?: unknown[] } | null | undefined)?.roots

	if (!Array.isArray(roots) || roots.length === 0) return null

	return (
		<ul className={`${styles.children} ${styles.treeView}`}>
			{(roots as TreeNode[]).map((n, i) => renderNode(n, String(i)))}
		</ul>
	)
}
