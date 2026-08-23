/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A `street_suffix` with no `street` anywhere in the tree, sitting against a locality, belongs to that locality.
 *
 *   `Brixton Hill, United Kingdom` parses as `{ street_suffix: "Hill", locality: "Brixton", country: … }`. The suffix
 *   is real English — `Hill` is a street type in `Ludgate Hill` and `Primrose Hill` — so the street-type channel fires
 *   on the token wherever it appears, and there is nothing street-shaped in the input to hold it. The resolver is then
 *   handed `Brixton` and finds a different place 300 km away, while the correct record sits under a name the parse
 *   never asks for.
 *
 *   `validate-tree.ts` has NAMED this shape since v0.7 task #37 — `stranded-dependent`, "a `street_suffix` floating
 *   with no `street` anywhere" — and nothing ever consumed it; `validateTree` is called only by its own test. So the
 *   diagnosis was written down years before the repair, which is the argument for the repair rather than against it.
 *
 *   ADJACENCY IS THE WHOLE GUARD, and it is what keeps this from being a guess. The suffix must be contiguous with the
 *   locality — whitespace only between the spans — so `12 Hill, London` (a genuine one-word street, suffix nowhere
 *   near the locality) is untouched, while `Brixton Hill` and `Notting Hill` reunite. A stranded suffix that neighbours
 *   nothing is left exactly as it is: this pass fixes a split, it does not delete evidence.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"

/**
 * Affix tags that cannot stand without a `street`. `house_number` is deliberately NOT here: a bare `12, London` is a
 * degenerate-but-honest parse, and absorbing a number into a place name would invent a name that was never written.
 */
const STRANDED_AFFIX_TAGS: ReadonlySet<string> = new Set(["street_suffix", "street_prefix"])

/**
 * Tags a stranded affix may be absorbed into — name-bearing place tags whose surface can legitimately end in a
 * street-type word: `Brixton Hill` the locality, `Bishop's Stortford` the venue, `Hythe Marina Village` the dependent
 * locality.
 *
 * `dependent_locality` belongs here for the same reason the other two do, and its absence stranded a suffix on a real
 * address: `MDL Hythe Marina Village, Shamrock Way, Hythe Marina Village, Hythe, Southampton SO45 6DY` tagged
 * `Shamrock` a dependent_locality and left `Way` with no street anywhere in the tree — a structurally invalid result
 * the board's own validity check flagged. A suburb name is no less able to end in `Way`, `Green` or `Row` than a
 * locality is.
 */
const ABSORBING_TAGS: ReadonlySet<string> = new Set(["locality", "venue", "dependent_locality"])

function walk(nodes: readonly AddressNode[], visit: (node: AddressNode) => void): void {
	for (const node of nodes) {
		visit(node)

		if (node.children?.length) {
			walk(node.children, visit)
		}
	}
}

/**
 * Absorb a stranded street affix into the place name it abuts.
 *
 * Mutates `tree` in place and returns whether anything moved, matching `repairPostcodeContradiction`'s shape so both
 * post-decode repairs read the same way at the call site.
 */
export function repairStrandedAffix(tree: AddressTree): boolean {
	const all: AddressNode[] = []

	walk(tree.roots, (node) => all.push(node))

	// A `street` ANYWHERE means the affix has a legitimate owner, whether or not the tree builder attached it.
	if (all.some((node) => node.tag === "street")) return false

	const stranded = all.filter((node) => STRANDED_AFFIX_TAGS.has(node.tag))

	if (!stranded.length) return false

	const raw = tree.raw
	let repaired = false

	for (const affix of stranded) {
		const absorber = all.find((node) => {
			if (!ABSORBING_TAGS.has(node.tag)) return false

			// Contiguous either way round — `Brixton Hill` (affix trails) and `Mount Pleasant` (affix leads) are the
			// same defect seen from two sides. Only whitespace may separate them.
			const between = affix.start >= node.end ? raw.slice(node.end, affix.start) : raw.slice(affix.end, node.start)

			return between.trim() === "" && between.length <= 1
		})

		if (!absorber) continue

		const [first, second] = affix.start < absorber.start ? [affix, absorber] : [absorber, affix]

		absorber.start = first.start
		absorber.end = second.end
		absorber.value = raw.slice(first.start, second.end)

		// Detach the affix wherever it hangs, including off the absorber itself.
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
