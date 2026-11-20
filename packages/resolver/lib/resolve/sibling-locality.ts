// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Sibling-locality containment: when a tree holds two resolved `locality` spans
 * and the gazetteer places a candidate of one inside the other's place, the inner
 * span resolves inside the outer place as a dependent locality.
 *
 * `Kensington, London` can decode as two localities.
 * Resolved apart, `Kensington` takes the largest namesake, Kensington, California, beside London.
 *
 * The gazetteer's containment decides which span is inner, so `London, Kensington` reads the same.
 */

import { collectNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolveNodeTrace, ResolverBackend } from "@mailwoman/core/resolver"

import { adminContainmentVerdict, partitionByContainment } from "#admin/containment"
import { decorateNode } from "#decorate-node"
import { createNodeTraceRecorder } from "#resolve/passes"
import { rankByImportance } from "#toponym-prior"

/**
 * The metadata stamp naming the outer place a sibling span resolved inside.
 */
export const SIBLING_LOCALITY_CONTAINMENT = "sibling_locality_containment"

/**
 * The most locality spans the pass pairs, because each ordered pair costs one lookup.
 */
const MAX_SIBLING_LOCALITIES = 3

interface SiblingLocalityOptions {
	/**
	 * The resolver placetype a `locality` span looks up.
	 */
	placetype: string
	limit: number
	traceSink: ((record: ResolveNodeTrace) => void) | null
}

/**
 * One ordered pair's reading: the inner span's candidates ranked with the outer place as their qualifier.
 */
interface ContainmentReading {
	inner: AddressNode
	outer: AddressNode
	outerID: number
	ranked: ResolvedPlace[]
}

function wofID(node: AddressNode): number | null {
	const id = node.placeID?.startsWith("wof:") ? Number(node.placeID.slice(4)) : Number.NaN

	return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * The inner span's candidates looked up with the outer place as the containment qualifier,
 * contained first, or null when none lies inside the outer place.
 */
async function readContainment(
	inner: AddressNode,
	outer: AddressNode,
	outerID: number,
	backend: ResolverBackend,
	opts: SiblingLocalityOptions
): Promise<ContainmentReading | null> {
	const country = outer.metadata?.["resolver_country"]

	const hits = await backend.findPlace({
		text: inner.value,
		placetype: opts.placetype,
		parentQualifierID: outerID,
		...(typeof country === "string" && country ? { country } : {}),
		limit: opts.limit,
	})

	const inside = (c: ResolvedPlace) => c.containedByQualifier === true && Number(c.id) !== outerID

	if (!hits.some(inside)) return null

	const ranked = partitionByContainment(rankByImportance(hits), inside, (c) => c.exactMatch === true)

	return { inner, outer, outerID, ranked }
}

/**
 * Resolves each inner `locality` span inside its sibling's place and retags it `dependent_locality`.
 *
 * A pair is read in both orders.
 * A pair whose spans each hold a candidate inside the other, or that resolved
 * to one place, is left as it was.
 */
export async function applySiblingLocalityContainment(
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	opts: SiblingLocalityOptions
): Promise<void> {
	const localities = collectNodes(roots, (n) => n.tag === "locality" && wofID(n) != null).slice(
		0,
		MAX_SIBLING_LOCALITIES
	)

	if (localities.length < 2) return

	const retagged = new Set<AddressNode>()

	for (const [i, a] of localities.entries()) {
		for (const b of localities.slice(i + 1)) {
			if (retagged.has(a) || retagged.has(b)) continue

			const aID = wofID(a)!
			const bID = wofID(b)!

			if (aID === bID) continue

			const aInB = await readContainment(a, b, bID, backend, opts)
			const bInA = await readContainment(b, a, aID, backend, opts)

			// The gazetteer must order the pair one way only.
			const reading = aInB && !bInA ? aInB : bInA && !aInB ? bInA : null

			if (!reading) continue

			const [top, ...alternatives] = reading.ranked

			decorateNode(reading.inner, top!, alternatives)
			reading.inner.tag = "dependent_locality"

			reading.inner.metadata = {
				...reading.inner.metadata,
				admin_containment: adminContainmentVerdict(reading.ranked),
				contained_by_parent: true,
				[SIBLING_LOCALITY_CONTAINMENT]: `wof:${reading.outerID}`,
			}

			retagged.add(reading.inner)

			if (opts.traceSink) {
				const rec = createNodeTraceRecorder(opts.traceSink)

				rec.bind(reading.inner, opts.placetype, { parentQualifierID: reading.outerID, limit: opts.limit }, opts.limit)
				rec.check(SIBLING_LOCALITY_CONTAINMENT)
				rec.stage("sibling_containment", reading.ranked)
				rec.emit({ id: top!.id, name: top!.name, source: "sibling_locality_containment" })
			}
		}
	}
}
