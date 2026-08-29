/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 3b of the candidate build — the containment sidecar (closure rows + interval labels).
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"
import type { DatabaseSync } from "@mailwoman/platform/sqlite"

import { placetypeDepth } from "../ancestry.ts"
import {
	CANDIDATE_ANCESTOR_COLUMNS,
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	createCandidateAncestorTable,
	createCandidateIntervalTable,
	MAX_ANCESTOR_DEPTH,
} from "../candidate-ancestors-schema.ts"
import type { CandidateDatabase } from "../candidate-schema.ts"
import type { PlaceAttrs } from "./place-attrs.ts"

/**
 * Pass 3b — the ancestors sidecar: closure rows + interval labels (candidate-ancestors-schema.ts owns the encoding
 * decision and the DAG/absence semantics). Reads the same source `ancestors` table the region stamp reads,
 * denormalizing each edge with the parent's name/key from `attrs`, streamed `ORDER BY id` so the clustered `(spr_id,
 * depth)` insert is sorted — the contiguous-leaves discipline of the candidate table itself.
 *
 * Excluded by policy: self rows, and placetypes outside the containment ladder (continent, empire, …: `placetypeDepth`
 * 0) — they discriminate nothing a consumer of this sidecar checks. An edge to a parent with no current `spr` row has
 * no name to denormalize; it is dropped and counted rather than stored blind.
 */
export async function buildAncestorsSidecar(ctx: {
	src: DatabaseSync
	out: DatabaseSync
	kdb: DatabaseClient<CandidateDatabase>
	attrs: Map<number, PlaceAttrs>
	ptID: (pt: string | null) => number
	progress: (phase: string, message: string) => void
}): Promise<{ ancestorRows: number; ancestorPlaces: number; intervalPlaces: number }> {
	const { src, out, attrs, ptID, progress } = ctx

	progress("ancestors", "building containment sidecar (closure rows + interval labels)")
	await createCandidateAncestorTable(ctx.kdb)
	await createCandidateIntervalTable(ctx.kdb)

	const insAncestor = out.prepare(
		`INSERT INTO ${CANDIDATE_ANCESTOR_TABLE} VALUES (${CANDIDATE_ANCESTOR_COLUMNS.map(() => "?").join(", ")})`
	)

	// The canonical-parent forest the interval labels are computed over. One parent per place — the
	// depth-1 edge (finest containment tier, lowest ancestor id; the `regionOf` MIN-stability
	// convention). ALL parents stay in the closure rows; only the interval tree canonicalizes.
	const canonicalParentOf = new Map<number, number>()
	const childrenOf = new Map<number, number[]>()
	const forest = new Set<number>()

	let ancestorRows = 0
	let ancestorPlaces = 0
	let droppedParents = 0

	// Per-child edge buffer; the stream below is grouped by child id, so each flush owns one place.
	let childID = -1
	let edges: Array<{ aid: number; apt: string }> = []

	const flush = (): void => {
		if (childID < 0 || !edges.length) return

		// Deterministic nearest-first: containment depth descending, then ancestor id ascending —
		// the FTS backend's `ancestorLineage` ordering, made stable across rebuilds.
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

	// Interval labels: pre/post-order DFS over the canonical-parent forest. Root order and child
	// order are id-ascending so the labels are stable across rebuilds of the same source.
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

				// Each child holds exactly one canonical parent, so a labeled node here means the
				// grouping upstream broke — skip rather than corrupt the numbering.
				if (preOf.has(kid)) continue

				preOf.set(kid, counter++)
				stack.push({ id: kid, next: 0 })
			} else {
				postOf.set(top.id, counter++)
				stack.pop()
			}
		}
	}

	// A canonical-parent CYCLE (corrupt source ancestry) leaves its members unreachable from any
	// root: they simply receive no label, and containment against them reads unverifiable — the
	// absence semantics the schema module states. Counted so a jump is visible across rebuilds.
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
