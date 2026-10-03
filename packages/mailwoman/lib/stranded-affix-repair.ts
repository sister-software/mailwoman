/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A `street_suffix` with no `street` anywhere in the tree and contiguous with a name-containing place belongs to that place, while a stranded affix that neighbors no adjacent span is left exactly as it is.
 */

import { type AddressNode, type AddressTree, collectNodes } from "@mailwoman/core/decoder"

/**
 * Affix tags that cannot stand without a `street`; `house_number` is deliberately absent
 * because absorbing a number into a place name would invent a name that was never written.
 */
const STRANDED_AFFIX_TAGS: ReadonlySet<string> = new Set(["street_suffix", "street_prefix"])

/**
 * Name-containing place tags that can absorb a stranded affix.
 *
 * Their surfaces can legitimately end in a street-type word.
 * `dependent_locality` belongs here for the same reason as `locality` and `venue`.
 */
const ABSORBING_TAGS: ReadonlySet<string> = new Set(["locality", "venue", "dependent_locality"])

/**
 * Absorbs a stranded street affix into the place name it abuts, mutating `tree` in place
 * and returning whether anything moved.
 */
export function repairStrandedAffix(tree: AddressTree): boolean {
	const all = collectNodes(tree.roots, () => true)

	// A `street` anywhere means the affix has a legitimate owner, whether or not the tree builder attached it.
	if (all.some((node) => node.tag === "street")) return false

	const stranded = all.filter((node) => STRANDED_AFFIX_TAGS.has(node.tag))

	if (!stranded.length) return false

	const raw = tree.raw
	let repaired = false

	for (const affix of stranded) {
		const absorber = all.find((node) => {
			if (!ABSORBING_TAGS.has(node.tag)) return false

			// The affix may lead or trail.
			// Only whitespace may separate the two spans.
			const between = affix.start >= node.end ? raw.slice(node.end, affix.start) : raw.slice(affix.end, node.start)

			return between.trim() === "" && between.length <= 1
		})

		if (!absorber) continue

		const [first, second] = affix.start < absorber.start ? [affix, absorber] : [absorber, affix]

		absorber.start = first.start
		absorber.end = second.end
		absorber.value = raw.slice(first.start, second.end)

		const detach = (nodes: AddressNode[]): void => {
			const index = nodes.indexOf(affix)

			if (index !== -1) {
				nodes.splice(index, 1)
			} else {
				for (const node of nodes)
					if (node.children?.length) {
						detach(node.children)
					}
			}
		}

		detach(tree.roots)
		repaired = true
	}

	return repaired
}
