/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The street-level coordinate tiers, in cascade order: exact address point (#476), house-number
 *   interpolation (#483), then the street-centroid fallback. Each answers WHERE, never WHICH PLACE —
 *   they stamp a coordinate onto the STREET node's metadata and never touch admin resolution.
 *
 *   Split out of `resolve.ts` so the resolver file holds the walk and the admin-coherence passes, and
 *   this one holds the tiers. The FR voie-type folding lives here because only the street-centroid
 *   tier consults it.
 */

import { isStreetDirectionalToken } from "@mailwoman/codex/us"
import { type AddressNode, walkNodes } from "@mailwoman/core/decoder"
import type { AddressPointLookup, InterpolationLookup, StreetCentroidLookup } from "@mailwoman/core/resolver"

import { foldName } from "#fold-name"

/**
 * Street-name component tags that, with the street node itself, reconstruct the full street string.
 */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Reassemble the full street string from the street node's subtree (#483 coverage fix). The parser nests the
 * directional/suffix as `street_prefix`/`street_suffix` CHILDREN of `street` (containment.ts), so `street.value` alone
 * is the bare base name ("Sheldon" for "East Sheldon Rd") — which misses the coordinate extracts keyed on the FULL
 * normalized name. Collect street + its prefix/particle/suffix descendants (NOT house_number/unit, which also nest
 * under street), order by span offset, and join.
 */
function assembleStreetValue(streetNode: AddressNode, directionalUnit?: AddressNode): string {
	const parts: AddressNode[] = []
	const stack = [streetNode]

	while (stack.length) {
		const n = stack.pop()!

		if (STREET_NAME_TAGS.has(n.tag) && n.value.trim()) {
			parts.push(n)
		}

		stack.push(...n.children)
	}

	// #718 admin-tail: a directional quadrant the model mis-tagged `unit` ("1532 Taylor Street NE" →
	// [unit] "NE") folds back into the street key by span order, so the situs/interp lookup matches the
	// extract's "taylor street northeast" (the lookup normalizer expands the abbreviation). Lookup-key
	// only — the parse output and admin resolution are untouched. Byte-stable when absent (undefined).
	if (directionalUnit && directionalUnit.value.trim()) {
		parts.push(directionalUnit)
	}

	parts.sort((a, b) => a.start - b.start)

	return parts.map((n) => n.value.trim()).join(" ")
}

/**
 * Directional quadrant values the model sometimes emits as a `unit` node instead of inside the street subtree (#718
 * admin-tail diagnostic: ~19% of the admin-fallback tail, 83% of DC). Folded into the street lookup key by
 * {@link assembleStreetValue}; the situs/interp lookup normalizer expands the abbreviation ("ne" → "northeast") so the
 * extract's full street name matches.
 */
// The 8 USPS cardinals/intercardinals (abbrev or name) — @codex/us owns the canonical table (#215).
const isDirectionalUnit = (value: string): boolean => isStreetDirectionalToken(value.replaceAll(".", ""))

/**
 * Address-point tier (#476): find `street` + `house_number` in the tree (first occurrence, depth-first), scope by the
 * tree's postcode/locality values, and on an exact hit stamp the point onto the STREET node's metadata. Additive only —
 * admin resolution is never altered.
 */
/**
 * Half-width (degrees) of the bbox derived from a resolved locality centroid for the #247 OSM bbox fall-through. ~0.25°
 * ≈ 28 km N–S — generous enough for a large metro whose centroid sits off the queried point, while the EXACT `(street,
 * number)` match keeps a cross-commune collision rare. The proper fix is per-point scope backfill (the OSM association
 * / point-in-polygon pass, #250); this is the coverage stopgap until then.
 */
const LOCALITY_BBOX_RADIUS_DEG = 0.25

/**
 * Every `(street, house_number)` pair the tree offers, nearest pair first: the house number whose span sits closest to
 * the street's, a number BEFORE the street winning a tie. A venue-led string parses more than one of each — `Bar 1802,
 * 22 Rue Pascal, 75005 Paris, France` carries two house numbers and one street, and `22` is the one written beside `Rue
 * Pascal`. The tiers probe the pairs in this order and stop at the first register hit, and the pair that hit is what
 * the result names; a walk that took "the first node of each tag" paired whatever the traversal met first.
 */
export function streetNumberPairs(
	roots: readonly AddressNode[]
): Array<{ street: AddressNode; houseNumber: AddressNode }> {
	const streets: AddressNode[] = []
	const numbers: AddressNode[] = []

	for (const node of walkNodes(roots)) {
		if (node.tag === "street") {
			streets.push(node)
		}

		if (node.tag === "house_number") {
			numbers.push(node)
		}
	}

	const pairs = streets.flatMap((street) => numbers.map((houseNumber) => ({ street, houseNumber })))

	return pairs.toSorted((a, b) => pairGap(a) - pairGap(b))
}

/**
 * Characters between a house number and its street; a number after the street costs one extra so the tie goes to the
 * number written before it, the order every Latin-script address system this resolver serves writes.
 */
function pairGap(pair: { street: AddressNode; houseNumber: AddressNode }): number {
	const { street, houseNumber } = pair

	if (houseNumber.end <= street.start) return street.start - houseNumber.end

	return houseNumber.start - street.end + 1
}

/**
 * The first node of `tag` in document order whose value is non-blank, when the tree carries one.
 */
function firstOfTag(roots: readonly AddressNode[], tag: AddressNode["tag"]): AddressNode | undefined {
	for (const node of walkNodes(roots)) {
		if (node.tag === tag && node.value.trim()) return node
	}

	return undefined
}

export function applyAddressPoint(roots: AddressNode[], lookup: AddressPointLookup, bboxFallback?: boolean): void {
	const pairs = streetNumberPairs(roots)
	const directionalUnit = [...walkNodes(roots)].find((n) => n.tag === "unit" && isDirectionalUnit(n.value))
	const localityNode = firstOfTag(roots, "locality")
	const locality = localityNode?.value.trim()
	const postcode = firstOfTag(roots, "postcode")?.value.trim()

	if (!pairs.length) return

	if (pairs.some((pair) => pair.street.metadata?.["resolution_tier"] === "address_point")) return

	// #247 OSM bbox fall-through: when enabled (an OSM extract is wired) and the locality resolved to a
	// coordinate, scope a final `(street, number)` probe by the locality's box — recovering OSM points that
	// carry no postcode/locality tag of their own. US situs never enables it, so its probes are byte-identical.
	let bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined

	if (bboxFallback && localityNode?.lat != null && localityNode.lon != null) {
		bbox = {
			minLat: localityNode.lat - LOCALITY_BBOX_RADIUS_DEG,
			maxLat: localityNode.lat + LOCALITY_BBOX_RADIUS_DEG,
			minLon: localityNode.lon - LOCALITY_BBOX_RADIUS_DEG,
			maxLon: localityNode.lon + LOCALITY_BBOX_RADIUS_DEG,
		}
	}

	let street: AddressNode | undefined
	let houseNumber: AddressNode | undefined
	let hit: ReturnType<AddressPointLookup["find"]> | undefined

	for (const pair of pairs) {
		hit = lookup.find({
			street: assembleStreetValue(pair.street, directionalUnit),
			number: pair.houseNumber.value,
			postcode,
			locality,
			bbox,
		})

		if (hit) {
			street = pair.street
			houseNumber = pair.houseNumber

			break
		}
	}

	if (!hit || !street || !houseNumber) return

	// The number the register answered for is the one the result names (tree-shape.ts `slotNodes` reads the stamp).
	houseNumber.metadata = { ...houseNumber.metadata, resolution_tier: "address_point" }

	street.metadata = {
		...street.metadata,
		address_point: {
			lat: hit.lat,
			lon: hit.lon,
			source: hit.source,
			release: hit.release,
			// The register row's OWN scope tags, when carried — a rooftop consumer can decorate the
			// commune/postcode the register attests even when the query never named them.
			...(hit.localityNorm ? { locality_norm: hit.localityNorm } : {}),
			...(hit.postcode ? { postcode: hit.postcode } : {}),
		},
		resolution_tier: "address_point",
	}
}

/**
 * House-number interpolation tier (#483): the third rung, consulted ONLY when the exact address-point tier
 * ({@link applyAddressPoint}) did NOT already stamp the street node (`resolution_tier === "address_point"`). That check
 * IS the "after the exact-point fall-through" — an estimate never overwrites a real situs point. Postcode-scoped (no
 * locality — the interpolators abstain statewide without a postcode). Stamps a DISTINCT metadata key
 * (`interpolated_point`, never `address_point`). Additive only — admin resolution is untouched.
 */
export function applyInterpolation(
	roots: AddressNode[],
	lookup: InterpolationLookup,
	radiusCalibration?: number
): void {
	const pairs = streetNumberPairs(roots)
	const directionalUnit = [...walkNodes(roots)].find((n) => n.tag === "unit" && isDirectionalUnit(n.value))
	const postcode = firstOfTag(roots, "postcode")?.value.trim()
	// The resolved locality's coordinate — the `near` tie-breaker the interpolator may consult when the query carries
	// no postcode and the covering ranges span several ZIPs (the borough-namesake class). Only a RESOLVED locality
	// qualifies; an unresolved one contributes nothing.
	const resolvedLocality = [...walkNodes(roots)].find((n) => n.tag === "locality" && n.lat != null && n.lon != null)

	const localityCoord = resolvedLocality ? { lat: resolvedLocality.lat!, lon: resolvedLocality.lon! } : undefined

	if (!pairs.length) return

	// The fall-through check: an exact situs point already won — never override it with an estimate.
	if (pairs.some((pair) => pair.street.metadata?.["resolution_tier"] === "address_point")) return

	const near = postcode ? undefined : localityCoord

	let street: AddressNode | undefined
	let houseNumber: AddressNode | undefined
	let hit: ReturnType<InterpolationLookup["find"]> | undefined

	for (const pair of pairs) {
		hit = lookup.find({
			street: assembleStreetValue(pair.street, directionalUnit),
			number: pair.houseNumber.value,
			postcode,
			...(near ? { near } : {}),
		})

		if (hit) {
			street = pair.street
			houseNumber = pair.houseNumber

			break
		}
	}

	if (!hit || !street || !houseNumber) return

	houseNumber.metadata = { ...houseNumber.metadata, resolution_tier: "interpolated" }
	// Conformal-calibrated radius (#374): the raw half-segment heuristic underestimates the true spread
	// (~72% coverage on Travis); ×1.70 → a 90% bound. The ARTIFACT's own multiplier (read from the extract's
	// `interp_calibration` metadata table at open time — `lookup.radiusCalibration`) is the default; an
	// explicit caller factor is the @internal instrument override. Neither present (extracts predating the
	// metadata table, no caller factor) keeps the raw value, byte-stable. Preserve the raw radius for
	// transparency.
	const factor = radiusCalibration ?? lookup.radiusCalibration
	const calibrated = factor ? Math.round(hit.uncertaintyM * factor) : hit.uncertaintyM

	street.metadata = {
		...street.metadata,
		interpolated_point: { lat: hit.lat, lon: hit.lon, source: hit.source, release: hit.release },
		resolution_tier: "interpolated",
		uncertainty_m: calibrated,
		...(factor ? { uncertainty_raw_m: hit.uncertaintyM, uncertainty_calibration: factor } : {}),
		interpolation_method: hit.method,
		...(hit.parityMatched !== undefined ? { parity_matched: hit.parityMatched } : {}),
		...(hit.bracket !== undefined ? { interpolation_bracket: hit.bracket } : {}),
	}
}

/**
 * French thoroughfare (voie) type tokens — the leading word that marks a street-only span as a THOROUGHFARE rather than
 * a place name ("Place Bellecour", "Cours de l'Intendance", "Quai des Bateliers"). Used by the #1042 street-centroid
 * tier to recognize a thoroughfare that the model mis-parsed as a `locality` (the FR no-street class, #901).
 * Deliberately generous — a false positive simply misses the exact street-centroid lookup and no-ops; the lookup is the
 * real check.
 */
const FR_VOIE_TYPES: ReadonlySet<string> = new Set([
	"rue",
	"ruelle",
	"venelle",
	"avenue",
	"av",
	"ave",
	"boulevard",
	"bd",
	"bld",
	"bvd",
	"boul",
	"place",
	"pl",
	"cours",
	"quai",
	"impasse",
	"imp",
	"allee",
	"all",
	"chemin",
	"ch",
	"che",
	"passage",
	"pas",
	"square",
	"sq",
	"faubourg",
	"fg",
	"fbg",
	"route",
	"rte",
	"esplanade",
	"promenade",
	"sentier",
	"sente",
	"villa",
	"cite",
	"hameau",
	"montee",
	"chaussee",
	"traverse",
	"mail",
	"clos",
	"voie",
	"quartier",
	"lotissement",
	"residence",
	"rond",
])

/**
 * Fold to lower-case, diacritic-stripped, punctuation-free tokens — a deliberate local copy of
 * `@mailwoman/resolver-wof-sqlite/street-normalize`'s `fold`: `@mailwoman/resolver` does not depend on that package, so
 * the two are kept in step by hand.
 */
function foldVoieTokens(s: string): string[] {
	return s
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/[.,'’]/g, "")
		.replaceAll("-", " ")
		.split(/\s+/)
		.filter((token) => token.length > 0)
}

/**
 * Does a string START with a French thoroughfare type token ("Rue …", "Place …")?
 */
function isVoieShaped(s: string): boolean {
	const first = foldVoieTokens(s)[0]

	return first !== undefined && FR_VOIE_TYPES.has(first)
}

/**
 * Push `v` (trimmed, non-empty, deduped, capped) onto `list`.
 */
function pushCandidate(list: string[], v: string | undefined, cap: number): void {
	const t = v?.trim()

	if (t && list.length < cap && !list.includes(t)) {
		list.push(t)
	}
}

/**
 * Street-centroid tier (#1042): the street-level rung BELOW the exact/interpolation tiers and ABOVE admin-centroid
 * resolution. For a STREET-ONLY query (a thoroughfare with NO house number), stamp the street's centroid onto a
 * `street` node so a consumer gets a street-level coordinate instead of the commune centroid (or a wrong namesake).
 *
 * The FR no-street class mis-parses the thoroughfare — "Place Bellecour, Lyon" parses `region=Lyon`, `locality="Place
 * Bellecour"`; "Avenue des Champs-Élysées" truncates — so this recovers the thoroughfare + commune RAW-TEXT-first (the
 * same substrate as span-rescore), preferring parsed nodes and falling back to the comma-split raw query. A
 * thoroughfare is recognized by its leading voie type ({@link isVoieShaped}); the commune is any non-voie span. Every
 * (thoroughfare, commune) pair is probed against the exact street-centroid lookup, first hit wins — a false candidate
 * simply misses. Additive only: fires ONLY when no house number is present (rooftop tiers untouched) and no
 * street-level coordinate already resolved, and never alters admin resolution.
 */
export function applyStreetCentroid(
	roots: AddressNode[],
	raw: string,
	provider: (country: string) => StreetCentroidLookup | undefined,
	hints: readonly string[]
): void {
	let streetNode: AddressNode | undefined
	let houseNumber = false
	let postcode: string | undefined
	// Region / locality values in document order (thoroughfare and commune both hide here), and the countries the tree
	// resolved to — a post-resolution country hint.
	const adminValues: string[] = []
	const resolvedCountries: string[] = []

	for (const n of walkNodes(roots)) {
		if (n.tag === "house_number") {
			houseNumber = true
		}

		if (n.tag === "street" && !streetNode) {
			streetNode = n
		}

		// Never shadow a real street-level coordinate the exact/interp tiers already stamped.
		if (n.metadata?.["resolution_tier"] === "address_point" || n.metadata?.["resolution_tier"] === "interpolated") {
			return
		}

		if (!postcode && n.tag === "postcode" && n.value.trim()) {
			postcode = n.value.trim()
		}

		if ((n.tag === "region" || n.tag === "locality" || n.tag === "dependent_locality") && n.value.trim()) {
			adminValues.push(n.value.trim())
		}

		const rc = (n.metadata?.["resolver_country"] as string | undefined)?.trim().toLowerCase()

		if (rc && !resolvedCountries.includes(rc)) {
			resolvedCountries.push(rc)
		}
	}

	if (houseNumber) return // street-only tier — a numbered address is the rooftop tiers' job

	// Candidate countries: pre-resolution hints (defaultCountry + unrestricted placer) then the resolved countries. BAN is
	// FR-only, so a non-FR candidate simply yields no lookup; the exact (street, base-commune) match is the real filter.
	const countries: string[] = []

	for (const c of [...hints, ...resolvedCountries]) {
		const cc = c?.trim().toLowerCase()

		if (cc && !countries.includes(cc)) {
			countries.push(cc)
		}
	}

	const lookups = countries.map((c) => provider(c)).filter((l): l is StreetCentroidLookup => l != null)

	if (!lookups.length) return

	const rawSegments = raw
		.split(",")
		.map((s) => s.trim())
		.filter((segment) => segment.length > 0)

	const CAP = 5

	// Thoroughfare candidates (parsed-first, then raw): the assembled street node, any voie-shaped parsed value, any
	// voie-shaped raw comma-segment. The parse often truncates these (Champs-Élysées → "Avenue des Champs"), so the raw
	// segment is the recovery — a candidate that misses just advances to the next.
	const thoroughfares: string[] = []

	if (streetNode) {
		pushCandidate(thoroughfares, assembleStreetValue(streetNode), CAP)
	}

	for (const v of adminValues) {
		if (isVoieShaped(v)) {
			pushCandidate(thoroughfares, v, CAP)
		}
	}

	for (const s of rawSegments) {
		if (isVoieShaped(s)) {
			pushCandidate(thoroughfares, s, CAP)
		}
	}

	if (!thoroughfares.length) return

	// Commune candidates: non-voie parsed admin values, then non-voie raw segments (a truncated/garbled parse loses the
	// commune — "Rue de la République, Marseille" parses `locality="e"` — so the raw "Marseille" is the recovery).
	const communes: string[] = []

	for (const v of adminValues) {
		if (!isVoieShaped(v)) {
			pushCandidate(communes, v, CAP)
		}
	}

	for (const s of rawSegments) {
		if (!isVoieShaped(s) && !thoroughfares.includes(s)) {
			pushCandidate(communes, s, CAP)
		}
	}

	for (const lookup of lookups) {
		for (const street of thoroughfares) {
			let hit = postcode ? lookup.find({ street, postcode }) : null
			let matchedCommune: string | undefined

			for (let i = 0; !hit && i < communes.length; i++) {
				hit = lookup.find({ street, locality: communes[i]! })

				if (hit) {
					matchedCommune = communes[i]
				}
			}

			if (!hit) continue

			const target =
				streetNode ??
				(() => {
					const injected: AddressNode = {
						tag: "street",
						value: street,
						start: 0,
						end: 0,
						confidence: 0.5,
						children: [],
					}

					roots.push(injected)

					return injected
				})()

			target.metadata = {
				...target.metadata,
				street_centroid: { lat: hit.lat, lon: hit.lon, source: hit.source, release: hit.release },
				resolution_tier: "street",
				uncertainty_m: hit.uncertaintyM,
			}

			// #1058: a commune-scoped hit is REGISTER evidence of the street's locality — record it for
			// the geocode layer's locality/city decoration, and drop any span-rescored locality that
			// contradicts it. Span-rescore injects SPECULATIVELY (a low-confidence street prefix like
			// "Rue" exact-matches the commune Rue in Somme); the register's exact (street, commune)
			// match is strictly stronger, so the injected token-of-the-street must not survive as the
			// result's city.
			if (matchedCommune) {
				target.metadata = { ...target.metadata, street_locality: matchedCommune }

				for (let i = roots.length - 1; i >= 0; i--) {
					const n = roots[i]!

					if (n.tag !== "locality" || n.metadata?.["span_rescore"] !== true) continue
					const names = [n.value, (n.metadata?.["resolver_name"] as string | undefined) ?? ""]

					if (!names.some((name) => foldName(name) === foldName(matchedCommune))) {
						roots.splice(i, 1)
					}
				}
			}

			return
		}
	}
}
