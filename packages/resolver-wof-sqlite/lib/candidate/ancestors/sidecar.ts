/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 3b of the candidate build — the containment sidecar (closure rows + interval labels).
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { placetypeDepth } from "#ancestry/index"
import {
	CANDIDATE_ANCESTOR_COLUMNS,
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	createCandidateAncestorTable,
	createCandidateIntervalTable,
	MAX_ANCESTOR_DEPTH,
} from "#candidate/ancestors/schema"
import type { PlaceAttrs } from "#candidate/place-attrs"
import type { CandidateDatabase } from "#candidate/schema"
import type { WOFDatabase } from "#schema"

/**
 * Build the ancestors sidecar (closure rows plus interval labels) from the source
 * `ancestors` table, excluding self rows and placetypes outside the containment ladder;
 * an edge to a parent with no current `spr` row is dropped and counted.
 */
export async function buildAncestorsSidecar(ctx: {
	src: DatabaseClient<WOFDatabase>
	out: DatabaseClient<CandidateDatabase>
	attrs: Map<number, PlaceAttrs>
	ptID: (pt: string | null) => number
	progress: (phase: string, message: string) => void
}): Promise<{ ancestorRows: number; ancestorPlaces: number; intervalPlaces: number }> {
	const { src, out, attrs, ptID, progress } = ctx

	progress("ancestors", "building containment sidecar (closure rows + interval labels)")
	await createCandidateAncestorTable(ctx.out)
	await createCandidateIntervalTable(ctx.out)

	const insAncestor = out.prepare(
		`INSERT INTO ${CANDIDATE_ANCESTOR_TABLE} VALUES (${CANDIDATE_ANCESTOR_COLUMNS.map(() => "?").join(", ")})`
	)

	// One parent per place (the finest containment tier, lowest ancestor id) canonicalizes
	// the interval tree; all parents stay in the closure rows.
	const canonicalParentOf = new Map<number, number>()
	const childrenOf = new Map<number, number[]>()
	const forest = new Set<number>()

	let ancestorRows = 0
	let ancestorPlaces = 0
	let droppedParents = 0

	// The stream is grouped by child id, so each flush owns one place.
	let childID = -1
	let edges: Array<{ aid: number; apt: string }> = []

	const flush = (): void => {
		if (childID < 0 || !edges.length) return

		// Deterministic nearest-first: containment depth descending, then ancestor id ascending,
		// matching the FTS backend's `ancestorLineage` ordering across rebuilds.
		edges.sort((a, b) => placetypeDepth(b.apt) - placetypeDepth(a.apt) || a.aid - b.aid)

		if (edges.length > MAX_ANCESTOR_DEPTH) {
			edges = edges.slice(0, MAX_ANCESTOR_DEPTH)
		}

		ancestorPlaces++

		for (const [i, edge] of edges.entries()) {
			const parent = attrs.get(edge.aid)!

			insAncestor.run(childID, i + 1, edge.aid, ptID(edge.apt), parent.name, parent.pkey)

			ancestorRows++
		}

		const canonical = edges[0]!.aid

		canonicalParentOf.set(childID, canonical)

		const siblings = childrenOf.get(canonical)

		if (siblings) {
			siblings.push(childID)
		} else {
			childrenOf.set(canonical, [childID])
		}

		forest.add(childID)
		forest.add(canonical)
	}

	out.exec("BEGIN")

	for (const r of src
		.prepare("SELECT id, ancestor_id, ancestor_placetype FROM ancestors WHERE ancestor_id != id ORDER BY id")
		.iterate()) {
		const id = Number(r.id)

		if (id !== childID) {
			flush()
			childID = id
			edges = []
		}

		if (!attrs.has(id)) continue

		const apt = String(r.ancestor_placetype ?? "")

		if (placetypeDepth(apt) === 0) continue

		const aid = Number(r.ancestor_id)

		if (!attrs.has(aid)) {
			droppedParents++

			continue
		}

		edges.push({ aid, apt })
	}

	flush()
	out.exec("COMMIT")

	// Interval labels are a pre/post-order DFS over the canonical-parent forest, with root
	// and child order id-ascending so labels stay stable across rebuilds.
	const preOf = new Map<number, number>()
	const postOf = new Map<number, number>()

	for (const kids of childrenOf.values()) {
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts an array this pass just built
		kids.sort((a, b) => a - b)
	}

	const roots = [...forest].filter((id) => !canonicalParentOf.has(id))

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts an array this pass just built
	roots.sort((a, b) => a - b)

	let counter = 0

	for (const root of roots) {
		preOf.set(root, counter++)
		const stack: Array<{ id: number; next: number }> = [{ id: root, next: 0 }]

		while (stack.length) {
			const top = stack.at(-1)!
			const kids = childrenOf.get(top.id)

			if (kids && top.next < kids.length) {
				const kid = kids[top.next++]!

				// Each child holds exactly one canonical parent, so a labeled node means
				// upstream grouping broke; skip rather than corrupt the numbering.
				if (preOf.has(kid)) continue

				preOf.set(kid, counter++)
				stack.push({ id: kid, next: 0 })
			} else {
				postOf.set(top.id, counter++)
				stack.pop()
			}
		}
	}

	// A canonical-parent cycle leaves its members unreachable from any root,
	// so they receive no label and containment against them reads unverifiable.
	const cycleSkipped = forest.size - preOf.size

	const insInterval = out.prepare(`INSERT INTO ${CANDIDATE_INTERVAL_TABLE} VALUES (?, ?, ?)`)
	const labeled = [...preOf.keys()]

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts an array this pass just built
	labeled.sort((a, b) => a - b)

	out.exec("BEGIN")

	for (const id of labeled) {
		insInterval.run(id, preOf.get(id)!, postOf.get(id)!)
	}

	out.exec("COMMIT")

	progress(
		"ancestors",
		`${ancestorRows.toLocaleString()} closure rows across ${ancestorPlaces.toLocaleString()} places; ` +
			`${preOf.size.toLocaleString()} interval labels` +
			(droppedParents ? `; ${droppedParents.toLocaleString()} edges dropped (parent has no current spr row)` : "") +
			(cycleSkipped ? `; ${cycleSkipped.toLocaleString()} places skipped (canonical-parent cycle)` : "")
	)

	return { ancestorRows, ancestorPlaces, intervalPlaces: preOf.size }
}
