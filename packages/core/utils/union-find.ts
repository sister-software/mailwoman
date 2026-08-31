/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A disjoint-set forest over string keys.
 */

export interface UnionFind {
	/**
	 * The representative of `key`'s set. An unseen key is its own representative.
	 */
	find: (key: string) => string
	/**
	 * Merge the sets holding `left` and `right`.
	 */
	union: (left: string, right: string) => void
}

/**
 * Path-compressing union-find. `find` walks iteratively, so a chain as long as the input — the shape a sorted ingest
 * produces when every row unions with the previous one — cannot overflow the stack the way a recursive walk does.
 */
export function createUnionFind(): UnionFind {
	const parent = new Map<string, string>()

	const find = (key: string): string => {
		let root = key

		while (true) {
			const next = parent.get(root)

			if (next === undefined || next === root) break
			root = next
		}

		let current = key

		while (current !== root) {
			const next = parent.get(current)!

			parent.set(current, root)
			current = next
		}

		return root
	}

	const union = (left: string, right: string): void => {
		const leftRoot = find(left)
		const rightRoot = find(right)

		if (leftRoot !== rightRoot) {
			parent.set(leftRoot, rightRoot)
		}
	}

	return { find, union }
}
