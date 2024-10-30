/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

type GraphNodeCallback<G> = (node: G) => boolean

/**
 * A graph structure for storing relationships between nodes.
 */
export class Graph<GraphNode> {
	public edges: Record<string, GraphNode[]> = {}

	/**
	 * Add a node to the graph.
	 */
	add(relationship: string, node: GraphNode): boolean {
		if (!this.edges[relationship]) {
			this.edges[relationship] = []
		}

		if (!this.edges[relationship].includes(node)) {
			this.edges[relationship].push(node)
			return true
		}
		return false
	}

	/**
	 * Remove a node from the graph.
	 */
	remove(relationship: string, node: GraphNode): boolean {
		if (!this.edges[relationship]) {
			return false
		}

		const len = this.edges[relationship].length
		this.edges[relationship] = this.edges[relationship].filter((n) => n !== node)

		if (!this.edges[relationship].length) {
			delete this.edges[relationship]
			return true
		}

		return this.edges[relationship].length !== len
	}

	/**
	 * Get the number of relationships in the graph.
	 */
	length(relationship: string): number {
		if (!this.edges[relationship]) {
			return 0
		}

		return this.edges[relationship].length
	}

	/**
	 * Find all nodes in a relationship.
	 */
	findAll(relationship: string): GraphNode[] {
		const nodes = this.edges[relationship]

		return nodes || []
	}

	/**
	 * Find one node in a relationship.
	 */
	findOne(relationship: string): GraphNode | null {
		const [firstNode = null] = this.edges[relationship] || []

		return firstNode
	}

	/**
	 * Predicate to determine if a relationship has a node that satisfies a condition.
	 */
	some(relationship: string, predicate?: GraphNodeCallback<GraphNode>): boolean {
		if (!predicate) return false

		return this.findAll(relationship).some(predicate)
	}

	/**
	 * Predicate to determine if all nodes in a relationship satisfy a condition.
	 */
	every(relationship: string, predicate?: GraphNodeCallback<GraphNode>): boolean {
		if (!predicate) return false

		const matches = this.findAll(relationship)
		return matches.length ? matches.every(predicate) : false
	}
}
