/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `TreeView` — the parse's containment tree as nested lists with a guide rail per level. The tag tint follows the
 *   confidence tier; the value and score render in monospace.
 */

import type { ReactNode } from "react"

import { confidenceTierOrMid } from "#common/confidence-tiers"

interface TreeNode {
	tag?: string
	value?: unknown
	confidence?: number
	children?: TreeNode[]
}

export interface TreeViewProps {
	/**
	 * The parser's `AddressTree` (`result.tree`): the view reads `.roots` and recurses `.children`.
	 */
	tree: unknown
}

function renderNode(node: TreeNode, path: string): ReactNode {
	if (typeof node.tag !== "string") return null

	const kids = Array.isArray(node.children) ? node.children : []

	return (
		<li key={path} className="mw-tree__node">
			<span className="mw-tree__row">
				<span className={`mw-tree__tag mw-tree__tag--${confidenceTierOrMid(node.confidence)}`}>{node.tag}</span>
				{node.value != null && String(node.value) !== "" ? (
					<span className="mw-tree__value">{String(node.value)}</span>
				) : null}
				{typeof node.confidence === "number" ? (
					<span className="mw-tree__conf">{node.confidence.toFixed(2)}</span>
				) : null}
			</span>
			{kids.length ? <ul className="mw-tree__children">{kids.map((c, i) => renderNode(c, `${path}.${i}`))}</ul> : null}
		</li>
	)
}

export function TreeView({ tree }: TreeViewProps): ReactNode {
	const roots = (tree as { roots?: unknown[] } | null | undefined)?.roots

	if (!Array.isArray(roots) || !roots.length) return null

	return <ul className="mw-tree mw-tree__children">{(roots as TreeNode[]).map((n, i) => renderNode(n, String(i)))}</ul>
}
