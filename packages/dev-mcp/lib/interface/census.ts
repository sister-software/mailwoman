/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Count structural violations in decoded trees. Illegal parent edges are builder defects; stranded
 *   dependent tags are model behavior, so their counts are reported alongside tag presence.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { STRICT_DEPENDENTS, validateTree, type AddressTree, type TreeViolation } from "@mailwoman/core/decoder"

/**
 * Return the grouping key for a violation.
 */
export function violationKey(violation: TreeViolation): string {
	return `${violation.type}:${violation.tag}`
}

/**
 * Example rows retained per violation class.
 */
const EXAMPLES_PER_CLASS = 5

export interface ViolationClass {
	type: TreeViolation["type"]
	tag: string
	n: number
	/**
	 * Example inputs and offending values for this class.
	 */
	examples: { id: string; input: string; value: string; detail: string }[]
}

export interface StrandingReading {
	tag: string
	/**
	 * Rows whose parse produced this tag; denominator for the stranding rate.
	 */
	produced_on_rows: number
	stranded: number
	/**
	 * `null` when the tag was never produced.
	 */
	stranding_rate: number | null
}

export interface InterfaceCensus {
	n_evaluated: number
	rows_violating: number
	classes: ViolationClass[]
	/**
	 * All strict dependent tags, including those never produced.
	 */
	stranding: StrandingReading[]
	/**
	 * Tags absent from all evaluated parses; their stranding rates are unmeasured.
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
	 * Number of rows containing this duplicate topology.
	 */
	n: number
	examples: { id: string; input: string; values: string[] }[]
}

export interface DuplicateTagCensus {
	/**
	 * Rows containing duplicate component tags.
	 */
	rows: number
	/**
	 * Fraction of evaluated rows with duplicate tags, or `null` when none were evaluated.
	 */
	rate: number | null
	/**
	 * Counts for every topology, including zero counts.
	 */
	topologies: { topology: DuplicateTagTopology; rows: number }[]
	classes: DuplicateTagClass[]
}

const DUPLICATE_TAG_TOPOLOGIES = ["sibling", "nested", "separate-branches"] as const

export interface InterfaceRow {
	id: string
	input: string
	tree: AddressTree
}

/**
 * Tally violations and duplicate tags across pre-parsed rows.
 */
export function censusTrees(rows: readonly InterfaceRow[]): InterfaceCensus {
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
 * Classify repeated tags by sibling, nested, or separate-branch relationships.
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

	// Distinct per row: a parse with two stranded `unit` nodes still produced `unit` on one row,
	// and counting it twice would let a single pathological row look like broad coverage.
	return [...new Set(tags)]
}
