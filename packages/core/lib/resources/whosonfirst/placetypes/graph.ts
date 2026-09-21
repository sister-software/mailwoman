/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PlacetypeRole } from "#resources/whosonfirst/placetypes/definition"
import type { Placetype } from "#resources/whosonfirst/placetypes/Placetype"

/**
 * A single node in a placetype graph.
 *
 * One entry per unique placetype name.
 */
export interface PlacetypeGraphNode {
	name: string
	/**
	 * Brooklyn Integers ID.
	 */
	id: number
	role: PlacetypeRole
}

/**
 * A directed parent → child edge.
 *
 * Field names match d3-force / react-flow / cytoscape conventions so the graph
 * drops straight into common viewers.
 */
export interface PlacetypeGraphLink {
	source: string
	target: string
}

/**
 * Node-link projection of the placetype DAG rooted at a given placetype.
 *
 * Each node and each (parent, child) edge appears exactly once.
 * See {@linkcode generatePlacetypeGraph} for why this is the preferred shape
 * when the root has many shared descendants (e.g. `planet`).
 */
export interface PlacetypeGraph {
	root: string
	nodes: PlacetypeGraphNode[]
	links: PlacetypeGraphLink[]
}

/**
 * Build a node-link graph of a placetype and its descendants, optionally filtered by role.
 *
 * Unlike {@linkcode generatePlacetypeTree}, this emits each node and each (parent, child) edge exactly once.
 * WOF placetypes form a DAG with heavy descendant sharing
 * (e.g. `installation` is a leaf reachable from many parents); projecting that DAG to
 * a nested tree duplicates every shared subtree under every parent path and blows up
 * exponentially for roots like `planet` (~165 MB for the full hierarchy).
 *
 * The graph shape stays O(nodes + edges) regardless.
 *
 * Output is well-suited for d3-force, react-flow, cytoscape, and any other html graph viewer.
 */
export function generatePlacetypeGraph(placetype: Placetype, roles?: Iterable<PlacetypeRole> | null): PlacetypeGraph {
	const roleSet = roles ? new Set(roles) : null

	const nodes = new Map<string, PlacetypeGraphNode>()
	const links: PlacetypeGraphLink[] = []
	const seenLinks = new Set<string>()
	const walked = new Set<string>()

	const addNode = (p: Placetype): void => {
		if (nodes.has(p.name)) return
		nodes.set(p.name, { name: p.name, id: p.id, role: p.role })
	}

	const walk = (node: Placetype): void => {
		walked.add(node.name)

		for (const child of node.findChildren(roleSet)) {
			addNode(child)

			const linkKey = `${node.name}\0${child.name}`

			if (!seenLinks.has(linkKey)) {
				seenLinks.add(linkKey)
				links.push({ source: node.name, target: child.name })
			}

			if (walked.has(child.name)) continue
			walk(child)
		}
	}

	addNode(placetype)
	walk(placetype)

	return {
		root: placetype.name,
		nodes: Array.from(nodes.values()),
		links,
	}
}
