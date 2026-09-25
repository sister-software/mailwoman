/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { PLACETYPE_FILTER_GROUPS } from "@mailwoman/codex/placetype-map"
import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"

import { decorateNode, isResolvedWithCoord } from "#decorate-node"

const REGION_LINEAGE_PLACETYPES: ReadonlySet<string> = new Set(PLACETYPE_FILTER_GROUPS["region"] ?? ["region"])

function placeIDValue(node: AddressNode): string | undefined {
	const match = /^[a-z]+:(.+)$/u.exec(node.placeID ?? "")

	return match?.[1]
}

/**
 * Un-resolves a parent-fallback pick whose stamped ancestors name a region other than
 * the resolved region above it, marking it `parent_fallback_refused`.
 *
 * A pick whose ancestor chain names no region is kept, because the fallback
 * exists for places with incomplete hierarchies.
 */
export function applyParentFallbackContradiction(roots: readonly AddressNode[]): void {
	const visit = (node: AddressNode, regionAncestor: AddressNode | null): void => {
		const regionHere = node.tag === "region" && placeIDValue(node) !== undefined ? node : regionAncestor

		if (regionHere && node !== regionHere && node.metadata?.["parent_fallback"] === true) {
			const regionID = placeIDValue(regionHere)

			const ancestors = node.metadata?.["ancestors"] as
				| ReadonlyArray<{ id: number | string; placetype: string }>
				| undefined

			const regions = (ancestors ?? []).filter((a) => REGION_LINEAGE_PLACETYPES.has(a.placetype))

			if (regionID !== undefined && regions.length && !regions.some((a) => String(a.id) === regionID)) {
				delete node.lat
				delete node.lon
				delete node.placeID
				delete node.alternatives

				const kept: Record<string, unknown> = {}

				for (const [key, value] of Object.entries(node.metadata ?? {})) {
					if (!key.startsWith("resolver_") && key !== "ancestors" && key !== "resolution_quality") {
						kept[key] = value
					}
				}

				node.metadata = { ...kept, parent_fallback_refused: true }
			}
		}

		for (const child of node.children) {
			visit(child, regionHere)
		}
	}

	for (const root of roots) {
		visit(root, null)
	}
}

/**
 * Re-picks a resolved region and its unresolved child locality as a pair, choosing
 * the region candidate that actually contains a same-named locality.
 *
 * This recovers cases such as "Portland, ME" where the region was picked in isolation
 * before the locality was known, and it leaves trees with a resolved locality untouched.
 */
export async function applyAdminCoherence(roots: readonly AddressNode[], backend: ResolverBackend): Promise<void> {
	const visit = async (node: AddressNode, regionAncestor: AddressNode | null): Promise<void> => {
		const regionHere = node.tag === "region" && isResolvedWithCoord(node) ? node : regionAncestor

		if (
			regionHere &&
			(node.tag === "locality" || node.tag === "dependent_locality") &&
			!isResolvedWithCoord(node) &&
			node.value.trim().length
		) {
			await reconcileAdminPair(regionHere, node, backend)
		}

		for (const child of node.children) {
			await visit(child, regionHere)
		}
	}

	for (const root of roots) {
		await visit(root, null)
	}
}

async function reconcileAdminPair(
	regionNode: AddressNode,
	localityNode: AddressNode,
	backend: ResolverBackend
): Promise<void> {
	const regionCands = ((regionNode.alternatives as ResolvedPlace[] | undefined) ?? []).filter((r) => r.exactMatch)

	for (const region of regionCands) {
		const scoped = await backend.findPlace({
			text: localityNode.value,
			placetype: "locality",
			parentID: region.id,
			limit: 3,
		})

		const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

		if (lc) {
			decorateNode(
				regionNode,
				region,
				regionCands.filter((r) => r !== region)
			)

			regionNode.metadata = { ...regionNode.metadata, admin_coherence_repicked: true }

			decorateNode(
				localityNode,
				lc,
				scoped.filter((l) => l !== lc)
			)

			localityNode.metadata = { ...localityNode.metadata, admin_coherence_repicked: true }

			return
		}
	}

	const countryCands = (await backend.findPlace({ text: regionNode.value, placetype: "country", limit: 3 })).filter(
		(c) => c.exactMatch
	)

	for (const country of countryCands) {
		const scoped = await backend.findPlace({
			text: localityNode.value,
			placetype: "locality",
			parentID: country.id,
			limit: 3,
		})

		const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

		if (lc) {
			decorateNode(regionNode, country, regionCands)
			regionNode.metadata = { ...regionNode.metadata, admin_coherence_repicked: true }

			decorateNode(
				localityNode,
				lc,
				scoped.filter((l) => l !== lc)
			)

			localityNode.metadata = { ...localityNode.metadata, admin_coherence_repicked: true }

			return
		}
	}

	const mc = matchCountry(regionNode.value)

	if (mc) {
		const scoped = await backend.findPlace({
			text: localityNode.value,
			placetype: "locality",
			country: mc.iso2,
			limit: 3,
		})

		const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

		if (lc) {
			decorateNode(
				localityNode,
				lc,
				scoped.filter((l) => l !== lc)
			)

			localityNode.metadata = { ...localityNode.metadata, admin_coherence_repicked: true }

			revertResolverDecoration(regionNode)
		}
	}
}

function revertResolverDecoration(node: AddressNode): void {
	const meta = { ...node.metadata }
	const priorSource = meta["classifier_source"]
	const priorSourceID = meta["classifier_source_id"]
	node.source = typeof priorSource === "string" ? priorSource : undefined
	node.sourceID = typeof priorSourceID === "string" ? priorSourceID : undefined

	for (const key of [
		"classifier_source",
		"classifier_source_id",
		"resolver_score",
		"resolver_prominence",
		"resolver_name",
		"resolver_country",
		"resolution_quality",
		"postcode_city_mismatch",
	]) {
		// oxlint-disable-next-line typescript/no-dynamic-delete -- removing one key from a plain record. the object is not on a hot path
		delete meta[key]
	}

	node.metadata = meta
	node.lat = undefined
	node.lon = undefined
	node.placeID = undefined
	node.alternatives = undefined
}

/**
 * Re-picks a locality to the same-named place inside the country the address names,
 * when that country is the locality's nearest admin context.
 *
 * It leaves the locality alone when it already resolved to that place or
 * when the named country holds no same-named locality.
 */
export async function applyExplicitCountryCoherence(
	roots: readonly AddressNode[],
	backend: ResolverBackend
): Promise<void> {
	const visit = async (node: AddressNode, countryToken: AddressNode | null, regionAbove: boolean): Promise<void> => {
		const countryHere = node.tag === "country" && node.value.trim().length ? node : countryToken

		const regionHere = regionAbove || ((node.tag === "region" || node.tag === "subregion") && isResolvedWithCoord(node))

		if (countryHere && !regionHere && (node.tag === "locality" || node.tag === "dependent_locality")) {
			await reconcileExplicitCountry(countryHere, node, backend)
		}

		for (const child of node.children) {
			await visit(child, countryHere, regionHere)
		}
	}

	for (const root of roots) {
		await visit(root, null, false)
	}
}

async function reconcileExplicitCountry(
	countryNode: AddressNode,
	localityNode: AddressNode,
	backend: ResolverBackend
): Promise<void> {
	const mc = matchCountry(countryNode.value)

	if (!mc) return

	const scoped = await backend.findPlace({
		text: localityNode.value,
		placetype: "locality",
		country: mc.iso2,
		limit: 3,
	})

	const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

	if (!lc) return

	if (localityNode.placeID === `wof:${lc.id}`) return

	decorateNode(
		localityNode,
		lc,
		scoped.filter((l) => l !== lc)
	)

	localityNode.metadata = { ...localityNode.metadata, explicit_country_repicked: true }
}

/**
 * Re-picks the region and locality into a foreign country when the region token is that
 * country's subdivision and the default-country filter left it unresolved.
 *
 * Both the foreign region and a same-named locality under that country must resolve,
 * so domestic queries whose region resolves are never changed.
 */
export async function applyRegionCountryCoherence(
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	defaultCountry: string | undefined
): Promise<void> {
	if (!defaultCountry) return

	const visit = async (node: AddressNode, regionAncestor: AddressNode | null): Promise<void> => {
		const regionHere = node.tag === "region" || node.tag === "subregion" ? node : regionAncestor

		if (
			regionHere &&
			!isResolvedWithCoord(regionHere) &&
			(node.tag === "locality" || node.tag === "dependent_locality") &&
			node.value.trim().length
		) {
			await reconcileRegionCountry(regionHere, node, backend, defaultCountry)
		}

		for (const child of node.children) {
			await visit(child, regionHere)
		}
	}

	for (const root of roots) {
		await visit(root, null)
	}
}

async function reconcileRegionCountry(
	regionNode: AddressNode,
	localityNode: AddressNode,
	backend: ResolverBackend,
	defaultCountry: string
): Promise<void> {
	const sub = matchSubdivision(regionNode.value)

	if (!sub) return

	if (sub.country.toUpperCase() === defaultCountry.toUpperCase()) return

	const localityCountry = (localityNode.metadata?.["resolver_country"] as string | undefined)?.toUpperCase()

	if (localityCountry === sub.country.toUpperCase()) return

	const regionScoped = await backend.findPlace({
		text: sub.name,
		placetype: "region",
		country: sub.country,
		limit: 3,
	})

	const rc = regionScoped.find((r) => r.exactMatch && !(r.lat === 0 && r.lon === 0))

	if (!rc) return

	const scoped = await backend.findPlace({
		text: localityNode.value,
		placetype: "locality",
		country: sub.country,
		limit: 3,
	})

	const lc = scoped.find((l) => l.exactMatch && !(l.lat === 0 && l.lon === 0))

	if (!lc) return

	decorateNode(
		regionNode,
		rc,
		regionScoped.filter((r) => r !== rc)
	)

	regionNode.metadata = { ...regionNode.metadata, region_country_repicked: true }

	decorateNode(
		localityNode,
		lc,
		scoped.filter((l) => l !== lc)
	)

	localityNode.metadata = { ...localityNode.metadata, region_country_repicked: true }
}
