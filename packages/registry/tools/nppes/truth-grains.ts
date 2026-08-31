/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The org-name entity-truth grains: union-find labellings that collapse co-located same-org NPIs, keyed three
 *   ways — the address string, a haversine co-location radius, and an H3 cell.
 */

import { createUnionFind, type UnionFind } from "@mailwoman/core/utils"
import { haversineKm, jaccard, type LatLon } from "@mailwoman/match"
import { latLngToCell } from "h3-js"

import type { SourceRecord } from "#index"
import { ORG_TAU, type NPIPrimary } from "#tools/nppes/org-name"

/**
 * Same-building distance for the coordinate grain — the `DEFAULT_DISTANCE_LEVELS` grain.
 */
export const COLOCATION_KM = 0.05

/**
 * A truth labelling: the entity class a record belongs to.
 */
export type TruthLabel = (rec: SourceRecord) => string

/**
 * Union every pair in each block whose org names agree.
 *
 * Quadratic within a block, which is what keeps the gate honest: the Jaccard test is per PAIR, so a chain of
 * near-matches cannot transitively fuse two genuinely distinct co-located orgs unless some pair actually agrees.
 */
function unionAgreeingPairs(
	blocks: Iterable<readonly string[]>,
	npiPrimary: Map<string, NPIPrimary>,
	uf: UnionFind
): void {
	for (const group of blocks) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				if (jaccard(npiPrimary.get(group[i]!)!.tokens, npiPrimary.get(group[j]!)!.tokens) >= ORG_TAU) {
					uf.union(group[i]!, group[j]!)
				}
			}
		}
	}
}

/**
 * An NPI's primary practice coordinate — the FIRST geocoded record it owns, which is its primary row because the sample
 * builder pushes that row before the alternate-name and mailing variants.
 */
export function collectPrimaryCoordinates(records: readonly SourceRecord[]): Map<string, LatLon> {
	const npiCoord = new Map<string, LatLon>()

	for (const rec of records) {
		const c = rec.address?.geocode?.coordinate

		if (c && !npiCoord.has(rec.id)) {
			npiCoord.set(rec.id, c)
		}
	}

	return npiCoord
}

/**
 * The string-keyed org-name truth: same NPI ⇒ same entity (so an NPI's records stay together and recall is preserved),
 * PLUS union two NPIs at the same address KEY whose primary org names agree.
 *
 * Blocking on the address string is a conservative LOWER bound — `1504 Taub LOOP` and `1504 Taub LP STE 100` key apart
 * even though they are one building, so a correct merge across them is still charged as an error. The coordinate grain
 * below is the tighter reading. Neither relies on the NPPES subpart flag, which the gold set showed misses 37%.
 */
export function buildOrgNameGrain(npiPrimary: Map<string, NPIPrimary>): TruthLabel {
	const uf = createUnionFind()
	const byAddr = new Map<string, string[]>()

	for (const [npi, info] of npiPrimary) {
		uf.find(npi)

		// seed
		if (!info.addrKey) continue

		if (!byAddr.has(info.addrKey)) {
			byAddr.set(info.addrKey, [])
		}

		byAddr.get(info.addrKey)!.push(npi)
	}

	unionAgreeingPairs(byAddr.values(), npiPrimary, uf)

	return (rec) => (npiPrimary.has(rec.id) ? uf.find(rec.id) : rec.id)
}

/**
 * The coordinate-keyed org-name truth: union same-org NPIs whose primary practice coordinates fall within
 * {@linkcode COLOCATION_KM}. Blocking by the GEOCODED BUILDING catches the same-building pairs the address string keys
 * apart, so this F1 is at or above the string grain's; the Jaccard gate still blocks distinct co-located orgs.
 *
 * Brute-force pairwise over the sampled NPIs — trivial at this scale, and unlike a cell key it has no boundary
 * artifact.
 */
export function buildOrgNameCoordGrain(npiPrimary: Map<string, NPIPrimary>, npiCoord: Map<string, LatLon>): TruthLabel {
	const uf = createUnionFind()
	const coLocated = [...npiPrimary.keys()].filter((n) => npiCoord.has(n))

	for (const n of npiPrimary.keys()) {
		uf.find(n)
	}

	// seed every NPI (un-geocoded ones stay singletons)
	for (let i = 0; i < coLocated.length; i++) {
		for (let j = i + 1; j < coLocated.length; j++) {
			const a = coLocated[i]!
			const b = coLocated[j]!

			if (haversineKm(npiCoord.get(a)!, npiCoord.get(b)!) > COLOCATION_KM) continue

			if (jaccard(npiPrimary.get(a)!.tokens, npiPrimary.get(b)!.tokens) >= ORG_TAU) {
				uf.union(a, b)
			}
		}
	}

	return (rec) => (npiPrimary.has(rec.id) ? uf.find(rec.id) : rec.id)
}

/**
 * The H3-cell org-name truth — the same building grain keyed on a cell instead of a radius, so co-location blocking is
 * O(n) rather than O(n²).
 *
 * A robustness check on the coordinate grain, not a replacement: a hard cell boundary can split a same-building pair
 * into adjacent cells, so this slightly UNDER-counts relative to the radius. Coarser resolutions absorb more of that.
 */
export function buildOrgNameH3Grain(
	npiPrimary: Map<string, NPIPrimary>,
	npiCoord: Map<string, LatLon>,
	h3Res: number
): TruthLabel {
	const uf = createUnionFind()
	const byCell = new Map<string, string[]>()

	for (const n of npiPrimary.keys()) {
		uf.find(n) // seed every NPI (un-geocoded ones stay singletons)
		const c = npiCoord.get(n)

		if (!c) continue
		const cell = latLngToCell(c.latitude, c.longitude, h3Res)

		if (!byCell.has(cell)) {
			byCell.set(cell, [])
		}

		byCell.get(cell)!.push(n)
	}

	unionAgreeingPairs(byCell.values(), npiPrimary, uf)

	return (rec) => (npiPrimary.has(rec.id) ? uf.find(rec.id) : rec.id)
}
