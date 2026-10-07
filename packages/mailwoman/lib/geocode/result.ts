/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import type { GeocodeOutcomeLike } from "@mailwoman/api"
import type { ComponentTag } from "@mailwoman/codex/component"
import { slotNodes, decodeAsJSON, type AddressNode, type AddressTree, type DroppedSpan } from "@mailwoman/core/decoder"
import type { QueryIntentMarker } from "@mailwoman/core/pipeline"
import type { DerivationProjection, EpistemicStatus } from "@mailwoman/evidence"
import { adminLadderForNodes } from "@mailwoman/resolver"

import { adminCoherenceField, type AdminCoherenceReport } from "#admin-coherence"
import type { AuthoritativeAssertion } from "#authoritative"
import { epistemicStatusFor } from "#geocode/epistemic-status"
import { capitalPromotionOf, postcodeCountryScopeOf, variantAliasExemptionOf } from "#geocode/tree-reads"
import { assembleHierarchy, lineageAnchorNode, type HierarchyEntry } from "#hierarchy-lineage"
import { assembleStreetName } from "#street/name-assembly"

/**
 * A parsed component that the answer's coordinate ignored.
 *
 * The only current `reason`, `postcode_move_refused`, means the postcode resolved
 * too far from the selected locality.
 */
export interface UnfollowedComponent {
	tag: ComponentTag
	value: string
	reason: "postcode_move_refused"

	/**
	 * The distance in kilometers that following this component would have moved the answer.
	 */
	distance_km: number
}

/**
 * The result that the geocode core returns for one input.
 */
export interface GeocodeResult {
	input: string

	/**
	 * Every parsed component, projected from the resolved tree.
	 *
	 * It includes locale-specific tags, such as `prefecture` and `block`, that the fixed fields omit.
	 */
	components: Partial<Record<ComponentTag, string>>

	/**
	 * Spans that the one-value-per-tag projection dropped.
	 * The field is null unless some were dropped.
	 */
	dropped_components: DroppedSpan[] | null

	/**
	 * Components in `components` that the coordinate ignored.
	 * The field is null unless some exist.
	 */
	unfollowed_components: UnfollowedComponent[] | null
	lat: number | null
	lon: number | null
	resolution_tier: ResolutionTier

	/**
	 * What may be claimed about the coordinate, as derived by `epistemicStatusFor`.
	 *
	 * It varies independently of `resolution_tier`.
	 * A rooftop answer is `designated` when its register is declared complete
	 * and `observed` when it comes from a crowdsourced extract.
	 */
	epistemic_status: EpistemicStatus

	/**
	 * The derivation behind this answer.
	 *
	 * It is null unless the caller supplied a resolver trace sink.
	 */
	derivation: DerivationProjection | null

	/**
	 * The poi.db entity that supplied the coordinate.
	 * It is null unless the `venue` tier answered.
	 */
	entity: { name: string; categoryID: string | null; confidence: number; country: string } | null

	/**
	 * The locality key and postcode stored on the matched address-point row.
	 *
	 * These values describe the rooftop rather than the query.
	 * Consumers may display them but must not filter on them.
	 */
	rooftop: { localityNorm: string | null; postcode: string | null } | null

	/**
	 * The uncertainty radius in meters, or null when the tier reports none.
	 */
	uncertainty_m: number | null
	locality: string | null
	region: string | null
	postcode: string | null

	/**
	 * The parsed house number, filled on every tier.
	 *
	 * Only the `address_point` and `interpolated` tiers place the coordinate at the house.
	 */
	house_number: string | null
	/**
	 * The parsed street name, reassembled from prefix, base and suffix.
	 */
	street: string | null

	/**
	 * The parsed venue span.
	 */
	venue: string | null

	/**
	 * The parsed dependent-locality span.
	 *
	 * It appears here even when `hierarchy` omits it for lack of a gazetteer match.
	 */
	dependent_locality: string | null

	/**
	 * The parsed unit or sub-venue span, such as `Suite 300` or `Gate 12`.
	 */
	unit: string | null

	/**
	 * The uppercase ISO 3166-1 alpha-2 code from the first node that includes a resolver country.
	 */
	countryCode: string | null

	/**
	 * The admin hierarchy from the resolver, most specific first.
	 *
	 * Each entry is resolved independently.
	 * `in_winner_lineage` is `true` when the entry lies on the winner's ancestor chain,
	 * `false` when it lies outside.
	 * The field is null when the chain is unknown.
	 */
	hierarchy: HierarchyEntry[]

	/**
	 * Candidate places for the query's primary place.
	 *
	 * The winner comes first, followed by the resolver's alternatives with distinct coordinates.
	 */
	candidates: Array<{
		name: string
		tag: string
		lat: number
		lon: number
		countryCode: string | null
		placeID: string | null
	}>

	/**
	 * The country that the postcode-country coherence pass scoped the resolve to.
	 *
	 * It is null unless the pass overrode the default country.
	 */
	postcode_country_scope: string | null

	/**
	 * The promoted candidate's country.
	 *
	 * It is null unless capital promotion changed a node's leading candidate.
	 */
	capital_promotion: string | null

	/**
	 * Set when the variant-alias exemption lifted a node's winner past the cross-country alias penalty.
	 */
	variant_alias_exemption: true | null

	/**
	 * Query-intent advisories.
	 * They never change the answer.
	 *
	 * The field is always present.
	 * An empty array means no intent marker matched.
	 */
	intent_markers: QueryIntentMarker[]

	/**
	 * Whether the winner's resolved ancestry confirms, contradicts or cannot check
	 * the parsed `region` and `country`.
	 *
	 * It is non-null whenever a winner resolved.
	 * Downstream ranking does not read it.
	 */
	admin_coherence: AdminCoherenceReport | null

	/**
	 * The answer from a configured authoritative provider, reported alongside Mailwoman's own answer.
	 *
	 * The field is null when no provider is configured.
	 * Every value inside comes from the provider, including `refused` and `transport_error`.
	 */
	authoritative: AuthoritativeAssertion | null
}

/**
 * The node the resolver labeled at the answer's coordinate, else the first
 * resolver-labeled node with a coordinate.
 */
function resolverNamedNode(
	allNodes: readonly AddressNode[],
	lat: number | null,
	lon: number | null
): AddressNode | null {
	return (
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat === lat && n.lon === lon) ??
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat != null) ??
		null
	)
}

function unfollowedComponents(allNodes: readonly AddressNode[]): UnfollowedComponent[] {
	const refusedKm = allNodes
		.map((node) => node.metadata?.["postcode_move_refused_km"])
		.find((km): km is number => typeof km === "number")

	if (refusedKm === undefined) return []

	const postcode = allNodes.find((node) => node.tag === "postcode")

	if (!postcode) return []

	return [{ tag: "postcode", value: postcode.value, reason: "postcode_move_refused", distance_km: refusedKm }]
}

/**
 * Projects a resolved address tree into a geocode result.
 *
 * The coordinate comes from the most precise tier present, in the order address point,
 * interpolated point, street centroid and admin ladder.
 */
export function extractGeocodeResult(input: string, tree: AddressTree): GeocodeOutcomeLike {
	const projected = decodeAsJSON(tree, { includeDropped: true })
	const { dropped, ...components } = projected

	const allNodes = slotNodes(tree.roots)
	const unfollowed = unfollowedComponents(allNodes)

	const streetNode = allNodes.find((n) => n.tag === "street")

	let lat: number | null = null
	let lon: number | null = null
	let tier: ResolutionTier = "admin"
	let uncertaintyM: number | null = null

	let rooftop: { localityNorm: string | null; postcode: string | null } | null = null

	let answeringBasis: string | null = null

	let adminWinnerNode: AddressNode | null = null

	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as
			| { lat: number; lon: number; locality_norm?: string; postcode?: string; basis?: string }
			| undefined

		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1
			answeringBasis = ap.basis ?? null

			if (ap.locality_norm || ap.postcode) {
				rooftop = {
					localityNorm: ap.locality_norm || null,
					postcode: ap.postcode || null,
				}
			}
		}
	}

	if (tier !== "address_point" && streetNode?.metadata?.["resolution_tier"] === "interpolated") {
		const ip = streetNode.metadata["interpolated_point"] as { lat: number; lon: number } | undefined

		if (ip) {
			lat = ip.lat
			lon = ip.lon
			tier = "interpolated"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | null) ?? null
		}
	}

	if (tier !== "address_point" && tier !== "interpolated" && streetNode?.metadata?.["resolution_tier"] === "street") {
		const sc = streetNode.metadata["street_centroid"] as { lat: number; lon: number } | undefined

		if (sc) {
			lat = sc.lat
			lon = sc.lon
			tier = "street"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | null) ?? null
		}
	}

	if (tier === "admin") {
		const adminPriority = adminLadderForNodes(allNodes)

		for (const tag of adminPriority) {
			const node = allNodes.find((n) => n.tag === tag && n.lat != null && n.lon != null)

			if (node) {
				lat = node.lat!
				lon = node.lon!
				adminWinnerNode = node

				break
			}
		}
	}

	const streetLocality =
		tier === "street" ? (streetNode?.metadata?.["street_locality"] as string | null)?.trim() || null : null

	const locality =
		streetLocality ??
		allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() ??
		null

	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

	const houseNumber = allNodes.find((n) => n.tag === "house_number")?.value?.trim() || null
	const street = streetNode ? assembleStreetName(streetNode) || null : null

	let countryCode: string | null = null

	for (const n of allNodes) {
		const c = (n.metadata?.["resolver_country"] as string | null)?.trim()

		if (c) {
			countryCode = c.toUpperCase()

			break
		}
	}

	const primaryNode = resolverNamedNode(allNodes, lat, lon)

	const hierarchy = assembleHierarchy(allNodes, streetLocality, adminWinnerNode ?? lineageAnchorNode(allNodes))

	const candidates: GeocodeResult["candidates"] = []

	if (primaryNode?.lat != null) {
		const seen = new Set<string>()
		const coordKey = (lt: number, ln: number): string => `${lt.toFixed(4)},${ln.toFixed(4)}`
		seen.add(coordKey(primaryNode.lat, primaryNode.lon!))

		candidates.push({
			name: (primaryNode.metadata?.["resolver_name"] as string | null)?.trim() || primaryNode.value.trim(),
			tag: primaryNode.tag,
			lat: primaryNode.lat,
			lon: primaryNode.lon!,
			countryCode: (primaryNode.metadata?.["resolver_country"] as string | null)?.trim()?.toUpperCase() ?? null,
			placeID: primaryNode.placeID || null,
		})

		const alts =
			(primaryNode.alternatives as ReadonlyArray<{
				name?: string
				placetype?: string
				lat?: number
				lon?: number
				country?: string
				id?: number | string
			}> | null) ?? []

		for (const a of alts) {
			if (a.lat == null || a.lon == null || !a.name) continue
			const key = coordKey(a.lat, a.lon)

			if (seen.has(key)) continue
			seen.add(key)

			candidates.push({
				name: String(a.name).trim(),
				tag: a.placetype ?? primaryNode.tag,
				lat: a.lat,
				lon: a.lon,
				countryCode: a.country ? String(a.country).trim().toUpperCase() : null,
				placeID: a.id != null ? `wof:${a.id}` : null,
			})
		}
	}

	const extractedOutcome: GeocodeOutcomeLike = {
		input,
		components,
		dropped_components: dropped?.length ? dropped : null,
		unfollowed_components: unfollowed.length ? unfollowed : null,
		lat,
		lon,
		resolution_tier: tier,
		epistemic_status: epistemicStatusFor(tier, lat, answeringBasis),
		uncertainty_m: uncertaintyM,
		locality,
		region,
		postcode,
		house_number: houseNumber,
		street,
		venue: allNodes.find((n) => n.tag === "venue")?.value ?? null,
		dependent_locality: allNodes.find((n) => n.tag === "dependent_locality")?.value?.trim() || null,
		unit: allNodes.find((n) => n.tag === "unit")?.value?.trim() || null,
		countryCode,
		hierarchy,
		candidates,
		rooftop,

		admin_coherence: adminCoherenceField(allNodes, adminWinnerNode, primaryNode),
		postcode_country_scope: postcodeCountryScopeOf(tree) ?? null,
		capital_promotion: capitalPromotionOf(tree),
		variant_alias_exemption: variantAliasExemptionOf(tree) === true ? true : null,

		intent_markers: [],
		derivation: null,
		entity: null,
		authoritative: null,
	}

	return extractedOutcome
}
