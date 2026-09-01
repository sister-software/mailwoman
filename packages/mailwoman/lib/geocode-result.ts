/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The geocode result contract — `ResolutionTier`, `GeocodeResult` — and `extractGeocodeResult`, the projection
 *   from a resolved tree into it. Split from `geocode-core.ts`, which owns the pipeline that produces the tree.
 */

import type { GeocodeOutcomeLike } from "@mailwoman/api"
import type { ComponentTag } from "@mailwoman/core"
import {
	collectNodes,
	decodeAsJSON,
	type AddressNode,
	type AddressTree,
	type DroppedSpan,
} from "@mailwoman/core/decoder"
import type { QueryIntentMarker } from "@mailwoman/core/pipeline"
import { adminLadderForNodes } from "@mailwoman/resolver"

import { adminCoherenceField, type AdminCoherenceReport } from "#admin-coherence"
import type { AuthoritativeAssertion } from "#authoritative"
import { capitalPromotionOf, postcodeCountryScopeOf, variantAliasExemptionOf } from "#geocode-tree-reads"
import { assembleHierarchy, lineageAnchorNode, type HierarchyEntry } from "#hierarchy-lineage"
import { assembleStreetName } from "#street-name-assembly"

/**
 * The resolution tier that produced the coordinate. `address_point` > `interpolated` > `street` > `admin`.
 *
 * - `address_point` — rooftop / parcel centroid; uncertainty_m is a small floor (~1 m)
 * - `interpolated` — house-number estimate; uncertainty_m is honest (calibrated bracket span)
 * - `street` — street centroid for a street-only query (#1042); uncertainty_m is half the street's bbox diagonal
 * - `admin` — admin centroid; uncertainty_m is null (no sub-locality estimate available)
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"

/**
 * The geocode-core result shape — the engine returns this verbatim (passthrough) to `/v1/geocode` and `/v1/batch`.
 */
export interface GeocodeResult {
	input: string
	/**
	 * Every parsed component, projected directly from the resolved tree. The named fields below remain the stable,
	 * convenience surface (and `street` remains reassembled), while this map keeps locale-specific schema such as JP's
	 * `prefecture` / `block` observable instead of silently dropping it at the geocoder boundary.
	 */
	components: Partial<Record<ComponentTag, string>>
	/**
	 * Spans the flat projection could not represent, present only when there were any (#1755).
	 *
	 * The flat map holds one value per tag, so a second `locality` span ceases to exist at the projection. Without this,
	 * `region: null` means both "the input named no region" and "it named one and we deleted it" — the meaning-of-zero
	 * rule applied to a component. A consumer rendering an answer can now say which happened.
	 */
	dropped_components?: DroppedSpan[]
	lat: number | null
	lon: number | null
	resolution_tier: ResolutionTier
	/**
	 * The entity the fork→entity probe resolved (#1585's entity half) — present ONLY when the `venue` tier answered: the
	 * decoder declared a fork, the incumbent path produced no coordinate, and exactly one poi.db entity bears the query's
	 * exact name (see `fork-entity.ts` for the three gates). Positive evidence only; absent everywhere else.
	 */
	entity?: { name: string; categoryID: string | null; confidence: number; country: string }
	/**
	 * The register row's OWN scope tags when the `address_point` tier answered and its database carries them: the
	 * attested locality (normalized key form) and postcode of the ROOFTOP, independent of what the query named. Consumers
	 * may decorate an answer with the register's commune/postcode (the Photon drop-in's `city` slot); never a filter,
	 * absent on every other tier.
	 */
	rooftop?: { localityNorm?: string; postcode?: string }
	/**
	 * Uncertainty radius in meters. null for the admin tier.
	 */
	uncertainty_m: number | null
	locality: string | null
	region: string | null
	postcode: string | null
	/**
	 * The PARSED house number + full street name (reassembled from the street subtree — prefix + base + suffix, since
	 * `street.value` alone is the bare base span), or null when the parse found neither. #1041 — lets a forward consumer
	 * that resolved to a house-number-grade coordinate (the `address_point` / `interpolated` {@link resolution_tier})
	 * render the result HOUSE-GRADE (`type: house` + `housenumber`/`street`, matching upstream Photon) instead of
	 * mislabeling a rooftop as its admin locality. Populated regardless of tier (they are the parsed spans); the consumer
	 * gates the house-grade rendering on the tier so an admin-only fallback is never dressed up as a rooftop.
	 */
	house_number: string | null
	street: string | null
	/**
	 * The PARSED venue span (same #1041 posture as house_number/street: populated regardless of tier, straight from the
	 * parse). Surfaced 2026-08-01 — the gauntlet's venue expectations had graded against nothing for their whole life
	 * because no result field carried the span (hierarchy filters to admin tags).
	 */
	venue: string | null
	/**
	 * The PARSED dependent-locality span (#1041 posture: the parse view, populated regardless of resolution). Distinct
	 * from `hierarchy`, which is the RESOLVED view — it only admits nodes the resolver decorated (lat/placeID), so a
	 * parsed-but-unresolved dependent locality (Abbey Hey with no gazetteer hit) never appears there. Surfaced 2026-08-01
	 * (hierarchy campaign R1) after the gauntlet's dep-loc expectations were found reading the resolved view.
	 */
	dependent_locality: string | null
	/**
	 * The PARSED unit / sub-venue span (#1041 posture, same as `venue` above: the parse view, populated regardless of
	 * tier) — `Terminal 5`, `Suite 300`, `Gate 12`.
	 *
	 * Surfaced 2026-08-05 for the same reason `venue` was in 2026-08-01, and found the same way: the gauntlet's sub-venue
	 * cases (added 2026-08-01) assert `unit`, no result field carried it, and `componentOf`'s deliberately-loud
	 * unknown-key throw meant the whole regression layer died the moment the corpus was rebuilt from its own seed. The
	 * committed corpus had been ungradeable since the day those cases landed; only the staleness of the built artifact
	 * hid it.
	 */
	unit: string | null
	/**
	 * ISO-3166 alpha-2 of the resolved place (the gazetteer/candidate country of the deepest resolved node), or null.
	 * #1014 — lets a forward consumer fill `country`/`countrycode` without a full ancestry walk (the candidate backend
	 * carries the country code even when it has no `ancestors()` table).
	 */
	countryCode: string | null
	/**
	 * Admin hierarchy from the resolver, locality → country (most specific first). `name` is the resolved gazetteer name
	 * (proper-cased canonical, #1014) — distinct from `value`, the raw parsed input span.
	 *
	 * Entries are INDEPENDENTLY resolved parse nodes, not one containment walk — so the chain can compose places no
	 * containment holds (#1731). `in_winner_lineage` states each entry's standing against the winner's stamped ancestor
	 * chain: `true` = vouched, `false` = resolved outside the winner's lineage (the chimera fragment), absent =
	 * unverifiable (no sidecar, or no place identity). See `hierarchy-lineage.ts`.
	 */
	hierarchy: HierarchyEntry[]
	/**
	 * Ranked candidate resolutions for the query's primary place — the winning place first, then the resolver's
	 * same-query alternatives (Springfield MO, MA, IL, …), each with its own coordinate + country. #1016 — lets a
	 * `limit`>1 / autocomplete client return the top-N matches instead of only the single best. The order reflects any
	 * proximity `bias`; an unambiguous result yields a single entry.
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
	 * The country #42's postcode-country coherence pass scoped the walk to, or null. Non-null ONLY when the pass actually
	 * overrode {@link GeocodeDeps.defaultCountry} — off, abstained and agreed-with-the-default all read null.
	 *
	 * This is the FIRING RECEIPT, and it exists because the alternative is unreadable evidence. A gate run with the lever
	 * OFF and one with it ON can come back identical for two opposite reasons: the mechanism ran on every row and changed
	 * nothing (the result worth having), or it never ran at all (the 2026-08-04 oa-resolver trap, where an identical 1.94
	 * MB dump turned out to mean the eval's database set carried no US postcodes). A magnitude never carries its own
	 * absence, so the pass reports its own count instead of leaving the reader to infer it.
	 */
	postcode_country_scope: string | null
	/**
	 * The #1880 capital promotion's firing receipt, in the same posture as {@link postcode_country_scope}: the promoted
	 * candidate's country, PRESENT only when the promotion changed some node's leading candidate. Absent means it never
	 * spoke — off, no capital in any race, or the capital already led. A lever-pinned comparison counts this instead of
	 * inferring activity from moved rows.
	 */
	capital_promotion?: string
	/**
	 * The #1882 variant-alias exemption's firing receipt (#1893), same posture as {@link capital_promotion}: PRESENT
	 * (`true`) only when some node's winning candidate reached the top because the exemption spared it the cross-country
	 * alias penalty. Absent means it never spoke — off, no variant row in any race, the variant lost, or a backend that
	 * never runs the primary-preference ranker.
	 */
	variant_alias_exemption?: true
	/**
	 * Query-intent advisories (ROAD_TO_V9 §4) — what the intent vocabulary had to say about the QUESTION, alongside the
	 * answer. **Always present**; an empty array is this path stating that the vocabulary looked and found nothing, which
	 * is a different claim from a missing field (the {@link `PipelineResult.faults`} discipline).
	 *
	 * Nothing here changed the answer. Three of the four markers are raised by the kind classifier from the string alone;
	 * the fourth (`declared_ambiguity`) is raised after the resolve by reading the ranked candidate list's dominance
	 * margin and comparing it to the measured 0.5-log10 decisive cut — a read, never a re-rank. This is the same
	 * narrow-channel posture {@link postcode_country_scope} set: an advisory RECEIPT inside a resolution contract, not a
	 * second opinion about the result.
	 */
	intent_markers: QueryIntentMarker[]
	/**
	 * Admin-coherence verdicts (#1717 stage 1) — did the winning candidate's resolved ancestry confirm, contradict, or
	 * fail to speak to the PARSED `region` / `country` qualifiers? Flag-only measurement in the same posture as
	 * {@link intent_markers}: nothing reads these to rank or gate, and the field is additive. Present whenever a winner
	 * resolved (both members always populated — `unstated` is the explicit no-qualifier claim); absent when the geocode
	 * produced no resolved winner to check against. See `admin-coherence.ts` for the verdict contract and the stated v1
	 * fold-equality bounds.
	 */
	admin_coherence?: AdminCoherenceReport
	/**
	 * A configured authoritative provider's answer (#1901), carried BESIDE Mailwoman's own — nothing above this field
	 * changes when it is present, and the field is absent (never null, never empty) when no provider is configured. Every
	 * value inside is the PROVIDER'S assertion, including a `refused` status (the provider spoke and said no — distinct
	 * from a parse failure and from an open-gazetteer miss) and a `transport_error` (the provider could not be reached,
	 * which absence would silently impersonate).
	 */
	authoritative?: AuthoritativeAssertion
}

/**
 * Walk the resolved tree and extract the geocode result: the street node's address-point / interpolation coordinate
 * (whichever tier won), else the best admin centroid (locality → region → country).
 */
export function extractGeocodeResult(input: string, tree: AddressTree): GeocodeOutcomeLike {
	// `includeDropped` is not optional here even though the flag is: a span the projection deleted is the ONE thing a
	// caller cannot reconstruct from the result, and #1755 is what its absence cost — the #1748 trailing region is
	// parsed, mistagged `locality`, and deleted at this line, which is why no decode lever ever moved that class.
	const projected = decodeAsJSON(tree, { includeDropped: true })
	const { dropped, ...components } = projected
	const allNodes = collectNodes(tree.roots, () => true)

	const streetNode = allNodes.find((n) => n.tag === "street")

	let lat: number | null = null
	let lon: number | null = null
	let tier: ResolutionTier = "admin"
	let uncertaintyM: number | null = null

	let rooftop: { localityNorm?: string; postcode?: string } | undefined

	// The admin-ladder node whose coordinate won (#1717) — captured where the ladder picks it, because
	// the primary-node probe below requires a `resolver_name` and a postcode-lookup winner may lack one.
	let adminWinnerNode: AddressNode | undefined

	if (streetNode?.metadata?.["resolution_tier"] === "address_point") {
		const ap = streetNode.metadata["address_point"] as
			| { lat: number; lon: number; locality_norm?: string; postcode?: string }
			| undefined

		if (ap) {
			lat = ap.lat
			lon = ap.lon
			tier = "address_point"
			uncertaintyM = 1

			// Floor: situs point is essentially exact.

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

	// Street-centroid tier (#1042): below rooftop/interp, above admin. Only reached for a street-only query the
	// exact tiers couldn't serve (they require a house number), so this never displaces a rooftop coordinate.
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
		// The ordering lives in `@mailwoman/resolver`'s `adminLadderFor`, beside the placetype scale the eval
		// harnesses sort by, so the two cannot disagree about where a postcode sits without failing a test.
		//
		// Two constraints this list carries and a reader cannot recover from the ordering alone. `postcode` has to
		// be ON the ladder at all: a lone-postcode query resolves the postcode node and nothing else, and without
		// the rung the result reported 0,0 despite a resolved coordinate (the proximity-bias feature's 48026 case).
		// And a unit-grade hit has to LEAD it: `29 Brecknock Road, London, N7 0BT` resolves its unit postcode to
		// 51.5500/-0.1307, 38 m from the rooftop truth, against a London centroid 5.6 km away — on all 15 GB
		// rooftop rows of the 2026-08-09 panel run. Nothing was missing from the gazetteer and no lookup failed;
		// the answer was on the tree and this list did not ask for it.
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

	// #1058: a commune-scoped street-centroid hit is REGISTER evidence of the street's locality — the
	// resolver stamps it as `street_locality` on the street node (and drops span-rescored locality
	// nodes that contradict it). Surface it as the result locality so `city` decorates from the
	// register's commune, never from a token of the street name ("Rue Sainte-Catherine, Bordeaux" →
	// "Bordeaux", not "Rue"). Unset for postcode-scoped hits (no commune evidence) and other tiers.
	const streetLocality =
		tier === "street" ? (streetNode?.metadata?.["street_locality"] as string | undefined)?.trim() || null : null

	const locality =
		streetLocality ??
		allNodes.find((n) => n.tag === "locality" || n.tag === "dependent_locality")?.value?.trim() ??
		null

	const region = allNodes.find((n) => n.tag === "region")?.value?.trim() || null
	const postcode = allNodes.find((n) => n.tag === "postcode")?.value?.trim() || null

	// #1041: the parsed house number + full street name, so a house-grade forward consumer (photon `/api`) can decorate a
	// rooftop / interpolated result with `housenumber`/`street` (matching upstream Photon) instead of the admin locality.
	const houseNumber = allNodes.find((n) => n.tag === "house_number")?.value?.trim() || null
	const street = streetNode ? assembleStreetName(streetNode) || null : null

	// #1014: the resolved ISO-3166 alpha-2 country (`resolver_country`, stamped by decorateNode). Same for every
	// resolved node of one address, so the first that carries it wins.
	let countryCode: string | null = null

	for (const n of allNodes) {
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) {
			countryCode = c.toUpperCase()

			break
		}
	}

	// #1016: ranked candidate places for the winning result — the resolved primary node (self) plus its
	// `alternatives` (the resolver's same-query runner-ups, already ranked and bias-aware). Each is a distinct place
	// with its own coordinate, so an ambiguous name (Springfield MO/MA/IL) returns all its instances for limit>1.
	// The primary is the resolved node whose coordinate WON (else the first resolved admin node — a bare-name query).
	const primaryNode =
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat === lat && n.lon === lon) ??
		allNodes.find((n) => n.metadata?.["resolver_name"] && n.lat != null)

	// #1731: lineage-graded against the admin-ladder pick when the admin tier answered, else the DEEPEST
	// resolved admin node — never the first-in-tree-order one, whose chain cannot contain its own
	// descendants (the 1600-Pennsylvania false flag the first mwdev_diagnose run caught).
	const hierarchy = assembleHierarchy(allNodes, streetLocality, adminWinnerNode ?? lineageAnchorNode(allNodes))

	const candidates: GeocodeResult["candidates"] = []

	if (primaryNode?.lat != null) {
		// Collapse same-point duplicates (a city + its coincident township share a centroid): two places at one
		// coordinate are not distinct autocomplete suggestions. ~11 m grid (4 decimals) keeps genuinely distinct
		// namesakes (Springfield MA vs IL are far apart) while dropping the variants.
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
		lat,
		lon,
		resolution_tier: tier,
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
		// #1717 stage 1: flag-only admin-coherence verdicts for the parsed region/country qualifiers, checked against
		// the winning candidate — the admin-ladder pick when the admin tier answered, else `primaryNode` (the first
		// resolved admin node — the resolution context the coordinate was scoped by). No winner → the field is absent.
		...adminCoherenceField(allNodes, adminWinnerNode, primaryNode),
		postcode_country_scope: postcodeCountryScopeOf(tree) ?? null,
		...((): { capital_promotion?: string } => {
			const promoted = capitalPromotionOf(tree)

			return promoted === undefined ? {} : { capital_promotion: promoted }
		})(),
		...(variantAliasExemptionOf(tree) === true ? { variant_alias_exemption: true as const } : {}),
		// `extractGeocodeResult` is a pure tree->result projection and has no access to the kind verdict, so it states
		// the empty case. `geocodeAddressOnce` is the caller that classifies and fills this in.
		intent_markers: [],
	}

	return extractedOutcome
}
