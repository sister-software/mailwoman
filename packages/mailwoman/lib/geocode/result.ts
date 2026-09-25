/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

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
 * Names the resolution tier that produced a result's coordinate, which also
 * determines how `uncertainty_m` is derived.
 *
 * `admin` results carry no uncertainty estimate, while `venue` and `plus_code` are
 * set by later overrides rather than by {@link extractGeocodeResult}.
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"

/**
 * Describes a parsed component the answer did not follow, where `reason` is a
 * resolver decision code a consumer can branch on.
 *
 * The only current reason, `postcode_move_refused`, means the postcode resolved too
 * far from the selected locality, since a transposed postcode is still a valid code
 * and disagreement is the only available signal.
 */
export interface UnfollowedComponent {
	tag: ComponentTag
	value: string
	reason: "postcode_move_refused"

	/**
	 * How far, in kilometers, following this component would have moved the answer.
	 */
	distance_km: number
}

/**
 * Defines the result shape the geocode core returns for one input.
 */
export interface GeocodeResult {
	input: string

	/**
	 * Every parsed component, projected directly from the resolved tree.
	 *
	 * It keeps locale-specific tags such as JP's `prefecture` and `block` that
	 * the named fields below do not carry.
	 */
	components: Partial<Record<ComponentTag, string>>

	/**
	 * Spans the one-value-per-tag projection could not represent, present only when there were any.
	 *
	 * Without it, a null `region` could mean either that the input named no region
	 * or that a second region span was discarded.
	 */
	dropped_components?: DroppedSpan[]

	/**
	 * Components kept in `components` that the answer did not follow, present only when there were any.
	 *
	 * Unlike `dropped_components`, these values still appear in the result,
	 * so this list is the only sign that the coordinate ignored them.
	 */
	unfollowed_components?: UnfollowedComponent[]
	lat: number | null
	lon: number | null
	resolution_tier: ResolutionTier

	/**
	 * What may be claimed about the coordinate, as derived by `epistemicStatusFor`.
	 *
	 * It is orthogonal to `resolution_tier`: the same rooftop tier is `designated` against a
	 * register its authority declares complete and `observed` against a crowdsourced extract.
	 */
	epistemic_status: EpistemicStatus

	/**
	 * The derivation behind this answer, present only when the caller supplied a resolver trace sink.
	 *
	 * Without a sink the resolver records nothing, so the field costs nothing when it is not requested.
	 */
	derivation?: DerivationProjection

	/**
	 * The poi.db entity that supplied the coordinate, present only when the `venue` tier answered.
	 */
	entity?: { name: string; categoryID: string | null; confidence: number; country: string }

	/**
	 * The locality key and postcode the matched register row records, present only on
	 * the `address_point` tier when the database carries them.
	 *
	 * They describe the rooftop, not the query, so consumers may use them to
	 * decorate an answer but never to filter one.
	 */
	rooftop?: { localityNorm?: string; postcode?: string }

	/**
	 * The uncertainty radius in meters, or null on the admin tier and when the tier reports none.
	 */
	uncertainty_m: number | null
	locality: string | null
	region: string | null
	postcode: string | null

	/**
	 * The parsed house number, populated regardless of tier.
	 *
	 * A consumer should render a house-grade result only on the `address_point` or `interpolated` tier.
	 */
	house_number: string | null
	/**
	 * The full parsed street name, reassembled from prefix, base and suffix and populated regardless of tier.
	 */
	street: string | null

	/**
	 * The parsed venue span, populated regardless of tier.
	 */
	venue: string | null

	/**
	 * The parsed dependent-locality span, populated regardless of resolution.
	 *
	 * `hierarchy` holds only resolved nodes, so a dependent locality with no
	 * gazetteer match appears here but not there.
	 */
	dependent_locality: string | null

	/**
	 * The parsed unit or sub-venue span, such as `Suite 300` or `Gate 12`, populated regardless of tier.
	 */
	unit: string | null

	/**
	 * The uppercase ISO 3166-1 alpha-2 code the resolver attached to the first node that carries one, or null.
	 */
	countryCode: string | null

	/**
	 * The admin hierarchy from the resolver, most specific first.
	 *
	 * Entries are independently resolved parse nodes, not one containment walk,
	 * so `in_winner_lineage` marks whether each entry lies on the winner's ancestor chain:
	 * `false` is outside it, and an absent value is unverifiable.
	 */
	hierarchy: HierarchyEntry[]

	/**
	 * Ranked candidate places for the query's primary place: the winner first,
	 * then the resolver's alternatives with distinct coordinates.
	 */
	candidates: Array<{
		name: string
		tag: string
		lat: number
		lon: number
		countryCode: string | null
		placeID?: string
	}>

	/**
	 * The country the postcode-country coherence pass scoped the resolve to, or null.
	 *
	 * It is non-null only when the pass overrode the default country, so a comparison
	 * can tell a pass that never ran from one that ran and changed nothing.
	 */
	postcode_country_scope: string | null

	/**
	 * The promoted candidate's country, present only when capital promotion
	 * changed some node's leading candidate.
	 */
	capital_promotion?: string

	/**
	 * Present only when some node's winner reached the top because the variant-alias
	 * exemption spared it the cross-country alias penalty.
	 */
	variant_alias_exemption?: true

	/**
	 * Query-intent advisories, which never change the answer.
	 *
	 * The field is always present; an empty array means the intent vocabulary looked and found nothing.
	 */
	intent_markers: QueryIntentMarker[]

	/**
	 * Whether the winner's resolved ancestry confirms, contradicts or cannot
	 * address the parsed `region` and `country`.
	 *
	 * It is present whenever a winner resolved and is never read for ranking.
	 */
	admin_coherence?: AdminCoherenceReport

	/**
	 * A configured authoritative provider's answer, carried beside Mailwoman's own without changing it.
	 *
	 * The field is absent when no provider is configured.
	 * Every value inside is the provider's assertion, including `refused` and `transport_error`.
	 */
	authoritative?: AuthoritativeAssertion
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
 * Projects a resolved address tree into a geocode result, taking the coordinate from the most precise
 * tier present: address point, then interpolated point, then street centroid, then the admin ladder.
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

	let rooftop: { localityNorm?: string; postcode?: string } | undefined

	let answeringBasis: string | undefined

	let adminWinnerNode: AddressNode | undefined

	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as
			| { lat: number; lon: number; locality_norm?: string; postcode?: string; basis?: string }
			| undefined

		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1
			answeringBasis = ap.basis

			if (ap.locality_norm || ap.postcode) {
				rooftop = {
					...(ap.locality_norm ? { localityNorm: ap.locality_norm } : {}),
					...(ap.postcode ? { postcode: ap.postcode } : {}),
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
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | undefined) ?? null
		}
	}

	if (tier !== "address_point" && tier !== "interpolated" && streetNode?.metadata?.["resolution_tier"] === "street") {
		const sc = streetNode.metadata["street_centroid"] as { lat: number; lon: number } | undefined

		if (sc) {
			lat = sc.lat
			lon = sc.lon
			tier = "street"
			uncertaintyM = (streetNode.metadata["uncertainty_m"] as number | undefined) ?? null
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
		tier === "street" ? (streetNode?.metadata?.["street_locality"] as string | undefined)?.trim() || null : null

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
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) {
			countryCode = c.toUpperCase()

			break
		}
	}

	const primaryNode =
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat === lat && n.lon === lon) ??
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat != null)

	const hierarchy = assembleHierarchy(allNodes, streetLocality, adminWinnerNode ?? lineageAnchorNode(allNodes))

	const candidates: GeocodeResult["candidates"] = []

	if (primaryNode?.lat != null) {
		const seen = new Set<string>()
		const coordKey = (lt: number, ln: number): string => `${lt.toFixed(4)},${ln.toFixed(4)}`
		seen.add(coordKey(primaryNode.lat, primaryNode.lon!))

		candidates.push({
			name: (primaryNode.metadata?.["resolver_name"] as string | undefined)?.trim() || primaryNode.value.trim(),
			tag: primaryNode.tag,
			lat: primaryNode.lat,
			lon: primaryNode.lon!,
			countryCode: (primaryNode.metadata?.["resolver_country"] as string | undefined)?.trim()?.toUpperCase() ?? null,
			...(primaryNode.placeID ? { placeID: primaryNode.placeID } : {}),
		})

		const alts =
			(primaryNode.alternatives as
				| ReadonlyArray<{
						name?: string
						placetype?: string
						lat?: number
						lon?: number
						country?: string
						id?: number | string
				  }>
				| undefined) ?? []

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
				...(a.id != null ? { placeID: `wof:${a.id}` } : {}),
			})
		}
	}

	const extractedOutcome: GeocodeOutcomeLike = {
		input,
		components,
		...(dropped?.length ? { dropped_components: dropped } : {}),
		...(unfollowed.length ? { unfollowed_components: unfollowed } : {}),
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
		...(rooftop ? { rooftop } : {}),

		...adminCoherenceField(allNodes, adminWinnerNode, primaryNode),
		postcode_country_scope: postcodeCountryScopeOf(tree) ?? null,
		...((): { capital_promotion?: string } => {
			const promoted = capitalPromotionOf(tree)

			return promoted === undefined ? {} : { capital_promotion: promoted }
		})(),
		...(variantAliasExemptionOf(tree) === true ? { variant_alias_exemption: true as const } : {}),

		intent_markers: [],
	}

	return extractedOutcome
}
