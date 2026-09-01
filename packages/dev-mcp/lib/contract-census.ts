/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   How often does the decoded tree violate its OWN structural contract?
 *
 *   `validateTree` states two invariants a tree can settle about itself — no illegal parent edge, no strict dependent
 *   left without an anchor. A parse can satisfy every asserted component and break both: the orphan fragments are
 *   invisible to any outcome test, because a component-match harness never looks at the edges. This asks the question
 *   at board scale — which classes fire, on what, and which never fire at all.
 *
 *   `mwdev_census` is the model for the discipline and this is its sibling one seam over: the census asks whether a
 *   parse-path MECHANISM signals on any row, this asks whether a decoder CONTRACT is broken on any row. Both refuse to
 *   let a zero stand unexplained.
 *
 *   **A zero means opposite things for the two checks, and blending them is the trap.** `illegal-edge` is enforced by
 *   `build-tree.ts` at construction, so zero is the DESIGNED state and any nonzero count is a regression in the
 *   builder. `stranded-dependent` is a real model behaviour, so zero there is ambiguous until you know whether the tag
 *   appeared at all — a `cedex` stranding count of 0 on a US-heavy board says nothing about stranding if no row ever
 *   produced a `cedex`. So the report carries tag PRESENCE beside every stranding count, and the two are never summed.
 */

import { STRICT_DEPENDENTS, validateTree, type AddressTree, type TreeViolation } from "@mailwoman/core/decoder"
import type { ComponentTag } from "@mailwoman/core/types"

/**
 * The tag this violation is about, and the class it belongs to — the key a tally groups on.
 */
export function violationKey(violation: TreeViolation): string {
	return `${violation.type}:${violation.tag}`
}

/**
 * Addresses kept per violation class. Enough to see whether a class is one recurring shape or several unrelated ones,
 * which is the distinction that decides whether it is a single defect; the full list is recoverable by re-running
 * against a filtered input set.
 */
const EXAMPLES_PER_CLASS = 5

export interface ViolationClass {
	type: TreeViolation["type"]
	tag: string
	n: number
	/**
	 * Rows that produced it, with the offending value, so a count leads back to an address rather than stopping at a
	 * number.
	 */
	examples: { id: string; input: string; value: string; detail: string }[]
}

export interface StrandingReading {
	tag: string
	/**
	 * Rows whose parse produced this tag AT ALL. The denominator that makes the stranding count readable: 0 stranded out
	 * of 0 produced is not a measurement of the model's stranding behaviour.
	 */
	produced_on_rows: number
	stranded: number
	/**
	 * `null` when the tag never appeared — a rate over an empty denominator, stated as absent rather than as 0.
	 */
	stranding_rate: number | null
}

export interface ContractCensus {
	n_evaluated: number
	rows_violating: number
	classes: ViolationClass[]
	/**
	 * Every strict dependent, whether or not it fired — the check's full denominator.
	 */
	stranding: StrandingReading[]
	/**
	 * Tags that never appeared in any parse, so their stranding count carries no information. Named because the
	 * alternative is a table of zeros a reader will read as a clean bill of health.
	 */
	never_produced: string[]
	illegal_edges: {
		n: number
		note: string
	}
	duplicate_tags: DuplicateTagCensus
}

export type DuplicateTagTopology = "sibling" | "nested" | "separate-branches"

export interface DuplicateTagClass {
	tag: ComponentTag
	topology: DuplicateTagTopology
	/**
	 * Rows, not node pairs. One pathological tree contributes at most once to this class.
	 */
	n: number
	examples: { id: string; input: string; values: string[] }[]
}

export interface DuplicateTagCensus {
	/**
	 * Rows containing two or more nodes with the same component tag.
	 */
	rows: number
	/**
	 * `rows / ContractCensus.n_evaluated`; null when no tree was evaluated.
	 */
	rate: number | null
	/**
	 * Complete topology inventory, including zero-event classes.
	 */
	topologies: { topology: DuplicateTagTopology; rows: number }[]
	classes: DuplicateTagClass[]
}

const DUPLICATE_TAG_TOPOLOGIES = ["sibling", "nested", "separate-branches"] as const

export interface ContractRow {
	id: string
	input: string
	tree: AddressTree
}

/**
 * Tally one corpus of already-parsed trees.
 *
 * Takes trees rather than inputs so the walk is pure and testable — the parse is the caller's, and the cost of a warm
 * engine is not this function's concern.
 */
export function censusTrees(rows: readonly ContractRow[]): ContractCensus {
	const classes = new Map<string, ViolationClass>()
	const produced = new Map<string, number>()
	const stranded = new Map<string, number>()
	const duplicateClasses = new Map<string, DuplicateTagClass>()
	const duplicateTopologyRows = new Map<DuplicateTagTopology, number>()
	let rowsViolating = 0
	let rowsWithDuplicateTags = 0

	for (const row of rows) {
		const duplicateTopologies = duplicateTagTopologies(row.tree)
		const rowTopologies = new Set([...duplicateTopologies.values()].flatMap((topologies) => [...topologies.keys()]))

		if (duplicateTopologies.size) {
			rowsWithDuplicateTags++
		}

		for (const topology of rowTopologies) {
			duplicateTopologyRows.set(topology, (duplicateTopologyRows.get(topology) ?? 0) + 1)
		}

		for (const [tag, topologies] of duplicateTopologies) {
			for (const [topology, values] of topologies) {
				const key = `${tag}:${topology}`
				const entry = duplicateClasses.get(key) ?? { tag, topology, n: 0, examples: [] }

				entry.n++

				if (entry.examples.length < EXAMPLES_PER_CLASS) {
					entry.examples.push({ id: row.id, input: row.input, values })
				}

				duplicateClasses.set(key, entry)
			}
		}

		for (const tag of tagsPresent(row.tree)) {
			if (STRICT_DEPENDENTS.has(tag)) {
				produced.set(tag, (produced.get(tag) ?? 0) + 1)
			}
		}

		const verdict = validateTree(row.tree)

		if (verdict.valid) continue

		rowsViolating++

		for (const violation of verdict.violations) {
			const key = violationKey(violation)
			const entry = classes.get(key) ?? { type: violation.type, tag: violation.tag, n: 0, examples: [] }

			entry.n++

			if (entry.examples.length < EXAMPLES_PER_CLASS) {
				entry.examples.push({
					id: row.id,
					input: row.input,
					value: violation.value,
					detail: violation.detail,
				})
			}

			classes.set(key, entry)

			if (violation.type === "stranded-dependent") {
				stranded.set(violation.tag, (stranded.get(violation.tag) ?? 0) + 1)
			}
		}
	}

	const strandingRows = [...STRICT_DEPENDENTS]
		.map((tag): StrandingReading => {
			const producedOn = produced.get(tag) ?? 0
			const strandedCount = stranded.get(tag) ?? 0

			return {
				tag,
				produced_on_rows: producedOn,
				stranded: strandedCount,
				stranding_rate: producedOn ? strandedCount / producedOn : null,
			}
		})
		.toSorted((a, b) => b.stranded - a.stranded || a.tag.localeCompare(b.tag))

	const illegalEdgeCount = [...classes.values()]
		.filter((entry) => entry.type === "illegal-edge")
		.reduce((total, entry) => total + entry.n, 0)

	return {
		n_evaluated: rows.length,
		rows_violating: rowsViolating,
		classes: [...classes.values()].toSorted((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)),
		stranding: strandingRows,
		never_produced: strandingRows.filter((entry) => entry.produced_on_rows === 0).map((entry) => entry.tag),
		illegal_edges: {
			n: illegalEdgeCount,
			note: illegalEdgeCount
				? "NONZERO. build-tree.ts enforces the edge invariant at construction, so this is a builder regression " +
					"rather than a model behaviour — the tags below name where."
				: "Zero, which is the DESIGNED state: build-tree.ts enforces the edge invariant at construction. Unlike " +
					"the stranding counts, this zero needs no row to justify it.",
		},
		duplicate_tags: {
			rows: rowsWithDuplicateTags,
			rate: rows.length ? rowsWithDuplicateTags / rows.length : null,
			topologies: DUPLICATE_TAG_TOPOLOGIES.map((topology) => ({
				topology,
				rows: duplicateTopologyRows.get(topology) ?? 0,
			})),
			classes: [...duplicateClasses.values()].toSorted(
				(a, b) => b.n - a.n || a.tag.localeCompare(b.tag) || a.topology.localeCompare(b.topology)
			),
		},
	}
}

interface TaggedNode {
	tag: ComponentTag
	value: string
	parent: number | null
	ancestors: ReadonlySet<number>
}

/**
 * Classify every repeated tag by the relationships among its nodes. A row may enter more than one topology for one tag:
 * three nodes can contain a nested pair while the third sits on a separate branch. Counts stay row-based within each
 * `(tag, topology)` class, so pair multiplication cannot inflate the result.
 */
function duplicateTagTopologies(tree: AddressTree): Map<ComponentTag, Map<DuplicateTagTopology, string[]>> {
	const nodes: TaggedNode[] = []

	const walk = (children: AddressTree["roots"], parent: number | null, ancestors: ReadonlySet<number>): void => {
		for (const child of children) {
			const index = nodes.length
			nodes.push({ tag: child.tag, value: child.value, parent, ancestors })
			walk(child.children, index, new Set([...ancestors, index]))
		}
	}

	walk(tree.roots, null, new Set())

	const byTag = Map.groupBy(nodes.entries(), ([, node]) => node.tag)
	const result = new Map<ComponentTag, Map<DuplicateTagTopology, string[]>>()

	for (const [tag, entries] of byTag) {
		if (entries.length < 2) continue

		const topologies = new Map<DuplicateTagTopology, Set<string>>()

		for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
			for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
				const [leftID, left] = entries[leftIndex]!
				const [rightID, right] = entries[rightIndex]!

				const topology: DuplicateTagTopology =
					left.parent === right.parent
						? "sibling"
						: left.ancestors.has(rightID) || right.ancestors.has(leftID)
							? "nested"
							: "separate-branches"

				const values = topologies.get(topology) ?? new Set<string>()

				values.add(left.value)
				values.add(right.value)
				topologies.set(topology, values)
			}
		}

		result.set(tag, new Map([...topologies].map(([topology, values]) => [topology, [...values]])))
	}

	return result
}

function tagsPresent(tree: AddressTree): ComponentTag[] {
	const tags: ComponentTag[] = []

	const walk = (nodes: AddressTree["roots"]): void => {
		for (const node of nodes) {
			tags.push(node.tag)

			walk(node.children)
		}
	}

	walk(tree.roots)

	// Distinct per ROW: a parse with two stranded `unit` nodes still produced `unit` on one row, and counting it twice
	// would let a single pathological row look like broad coverage.
	return [...new Set(tags)]
}
