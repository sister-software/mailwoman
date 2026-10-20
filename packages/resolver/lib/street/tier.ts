/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isFrenchStreetWord } from "@mailwoman/codex/fr"
import { isStreetDirectionalToken } from "@mailwoman/codex/us"
import { collectNodes, walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { AddressPointLookup, Ancestor, InterpolationLookup, StreetCentroidLookup } from "@mailwoman/core/resolver"
import { TextSpliterator } from "spliterator"

import { foldName } from "#fold-name"

const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

function assembleStreetValue(streetNode: AddressNode, directionalUnit?: AddressNode): string {
	const parts = collectNodes([streetNode], (n) => STREET_NAME_TAGS.has(n.tag) && n.value.trim().length)

	if (directionalUnit && directionalUnit.value.trim()) {
		parts.push(directionalUnit)
	}

	parts.sort((a, b) => a.start - b.start)

	return parts.map((n) => n.value.trim()).join(" ")
}

const isDirectionalUnit = (value: string): boolean => isStreetDirectionalToken(value.replaceAll(".", ""))

const LOCALITY_BBOX_RADIUS_DEG = 0.25

interface LatLonBox {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

/**
 * WOF placetypes whose name a register can store as the locality of an address in a finer place.
 *
 * A register keyed to a city stores an address in one of its boroughs
 * or neighborhoods under the city's name, so a miss on the parsed place is retried
 * with each ancestor of these placetypes, nearest first.
 */
const LOCALITY_ANCESTOR_PLACETYPES: ReadonlySet<string> = new Set([
	"neighbourhood",
	"macrohood",
	"borough",
	"locality",
	"localadmin",
])

/**
 * Reads the resolved place's own extent from `resolver_bbox`, which `decorateNode`
 * writes only for an extent with area.
 */
function resolvedExtent(node: AddressNode | null | undefined): LatLonBox | null {
	const box = node?.metadata?.["resolver_bbox"] as Partial<LatLonBox> | undefined

	if (
		typeof box?.minLat !== "number" ||
		typeof box.maxLat !== "number" ||
		typeof box.minLon !== "number" ||
		typeof box.maxLon !== "number"
	) {
		return null
	}

	return { minLat: box.minLat, maxLat: box.maxLat, minLon: box.minLon, maxLon: box.maxLon }
}

function boxContains(box: LatLonBox, lat: number, lon: number): boolean {
	return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon
}

/**
 * Returns the names of the resolved locality's ancestors that a register could
 * store as its locality, nearest first.
 */
function ancestorLocalityNames(
	node: AddressNode | null,
	ancestorsOf: ((id: number | string) => Ancestor[]) | undefined
): string[] {
	if (!node || !ancestorsOf || typeof node.placeID !== "string" || !node.placeID.startsWith("wof:")) return []

	const own = node.value.trim().toLowerCase()
	const names: string[] = []

	for (const ancestor of ancestorsOf(node.placeID.slice("wof:".length))) {
		const name = ancestor.name.trim()

		if (!LOCALITY_ANCESTOR_PLACETYPES.has(ancestor.placetype) || !name) continue

		if (name.toLowerCase() === own || names.includes(name)) continue

		names.push(name)
	}

	return names
}

/**
 * Returns every `(street, house_number)` pair in the tree, ordered by how close the
 * two spans sit, with a number before the street winning a tie.
 *
 * A venue-led address can contain several house numbers.
 * The tiers take the first pair that hits the register.
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

function pairGap(pair: { street: AddressNode; houseNumber: AddressNode }): number {
	const { street, houseNumber } = pair

	if (houseNumber.end <= street.start) return street.start - houseNumber.end

	return houseNumber.start - street.end + 1
}

function firstOfTag(roots: readonly AddressNode[], tag: AddressNode["tag"]): AddressNode | null {
	for (const node of walkNodes(roots)) {
		if (node.tag === tag && node.value.trim()) return node
	}

	return null
}

/**
 * Stamps the street with an exact address-point coordinate from the first street
 * and number pair the lookup finds.
 *
 * With `bboxFallback`, the lookup is also bounded to a box around the resolved locality's coordinate.
 *
 * With `ancestorsOf`, a miss is retried with the names of the resolved locality's WOF ancestors,
 * nearest first, for a register that keys a borough or neighborhood to its city.
 * An ancestor-keyed row answers only when it lies inside the resolved locality's own bounding box,
 * because the ancestor key also matches the same street and number in the ancestor's other parts.
 * A locality without a bounding box gets no retry.
 */
export function applyAddressPoint(
	roots: AddressNode[],
	lookup: AddressPointLookup,
	bboxFallback?: boolean,
	ancestorsOf?: (id: number | string) => Ancestor[]
): void {
	const pairs = streetNumberPairs(roots)
	const directionalUnit = [...walkNodes(roots)].find((n) => n.tag === "unit" && isDirectionalUnit(n.value))
	const localityNode = firstOfTag(roots, "locality")
	const locality = localityNode?.value.trim()
	const postcode = firstOfTag(roots, "postcode")?.value.trim()

	const region = firstOfTag(roots, "region")?.value.trim()
	const subregion = firstOfTag(roots, "subregion")?.value.trim()

	if (!pairs.length) return

	if (pairs.some((pair) => pair.street.metadata?.["resolution_tier"] === "address_point")) return

	let bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null

	if (bboxFallback && localityNode?.lat != null && localityNode.lon != null) {
		bbox = {
			minLat: localityNode.lat - LOCALITY_BBOX_RADIUS_DEG,
			maxLat: localityNode.lat + LOCALITY_BBOX_RADIUS_DEG,
			minLon: localityNode.lon - LOCALITY_BBOX_RADIUS_DEG,
			maxLon: localityNode.lon + LOCALITY_BBOX_RADIUS_DEG,
		}
	}

	let street: AddressNode | null = null
	let houseNumber: AddressNode | null = null
	let hit: ReturnType<AddressPointLookup["find"]> | null = null

	for (const pair of pairs) {
		hit = lookup.find({
			street: assembleStreetValue(pair.street, directionalUnit),
			number: pair.houseNumber.value,
			postcode: postcode ?? null,
			locality: locality ?? null,
			region: region ?? null,
			subregion: subregion ?? null,
			bbox,
		})

		if (hit) {
			street = pair.street
			houseNumber = pair.houseNumber

			break
		}
	}

	let ancestorLocality: string | null = null
	const extent = resolvedExtent(localityNode)

	if (!hit && locality && extent) {
		retry: for (const name of ancestorLocalityNames(localityNode, ancestorsOf)) {
			for (const pair of pairs) {
				const candidate = lookup.find({
					street: assembleStreetValue(pair.street, directionalUnit),
					number: pair.houseNumber.value,
					postcode: postcode ?? null,
					locality: name,
					region: region ?? null,
					subregion: subregion ?? null,
					bbox,
				})

				if (candidate && boxContains(extent, candidate.lat, candidate.lon)) {
					hit = candidate
					street = pair.street
					houseNumber = pair.houseNumber
					ancestorLocality = name

					break retry
				}
			}
		}
	}

	if (!hit || !street || !houseNumber) return

	houseNumber.metadata = { ...houseNumber.metadata, resolution_tier: "address_point" }

	street.metadata = {
		...street.metadata,
		address_point: {
			lat: hit.lat,
			lon: hit.lon,
			source: hit.source,
			release: hit.release,
			locality_norm: hit.localityNorm || null,
			postcode: hit.postcode || null,
		},
		resolution_tier: "address_point",
		...(ancestorLocality ? { address_point_ancestor_locality: ancestorLocality } : {}),
	}
}

/**
 * Stamps the street with an interpolated house-number coordinate when the
 * address-point tier did not already place it.
 *
 * It writes `interpolated_point` rather than `address_point`, so an estimate
 * never overwrites a real situs point.
 *
 * A query without a postcode is scoped only by its locality, so its estimate must lie inside the resolved
 * locality's bounding box, and an estimate outside it is refused as a namesake street elsewhere.
 * A postcode-scoped estimate is not checked, because a mailing city's postcode
 * can reach past the WOF place's extent.
 */
export function applyInterpolation(
	roots: AddressNode[],
	lookup: InterpolationLookup,
	radiusCalibration?: number
): void {
	const pairs = streetNumberPairs(roots)
	const directionalUnit = [...walkNodes(roots)].find((n) => n.tag === "unit" && isDirectionalUnit(n.value))
	const postcode = firstOfTag(roots, "postcode")?.value.trim()

	const resolvedLocality = [...walkNodes(roots)].find((n) => n.tag === "locality" && n.lat != null && n.lon != null)

	const localityCoord = resolvedLocality ? { lat: resolvedLocality.lat!, lon: resolvedLocality.lon! } : null

	if (!pairs.length) return

	if (pairs.some((pair) => pair.street.metadata?.["resolution_tier"] === "address_point")) return

	const near = postcode ? undefined : localityCoord
	const extent = postcode ? null : resolvedExtent(resolvedLocality)

	let street: AddressNode | null = null
	let houseNumber: AddressNode | null = null
	let hit: ReturnType<InterpolationLookup["find"]> | null = null

	for (const pair of pairs) {
		hit = lookup.find({
			street: assembleStreetValue(pair.street, directionalUnit),
			number: pair.houseNumber.value,
			postcode,
			...(near ? { near } : {}),
		})

		if (hit && extent && !boxContains(extent, hit.lat, hit.lon)) {
			hit = null
		}

		if (hit) {
			street = pair.street
			houseNumber = pair.houseNumber

			break
		}
	}

	if (!hit || !street || !houseNumber) return

	houseNumber.metadata = { ...houseNumber.metadata, resolution_tier: "interpolated" }

	const factor = radiusCalibration ?? lookup.radiusCalibration
	const calibrated = factor ? Math.round(hit.uncertaintyM * factor) : hit.uncertaintyM

	street.metadata = {
		...street.metadata,
		interpolated_point: { lat: hit.lat, lon: hit.lon, source: hit.source, release: hit.release },
		resolution_tier: "interpolated",
		uncertainty_m: calibrated,
		...(factor ? { uncertainty_raw_m: hit.uncertaintyM, uncertainty_calibration: factor } : {}),
		interpolation_method: hit.method,
		...(hit.parityMatched != null ? { parity_matched: hit.parityMatched } : {}),
		...(hit.bracket ? { interpolation_bracket: hit.bracket } : {}),
	}
}

const FR_GENEROUS_VOIE_TOKENS: ReadonlySet<string> = new Set([
	"quartier",

	"rond",
])

function foldVoieTokens(s: string): string[] {
	return s
		.normalize("NFKD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/[.,'’]/g, "")
		.replaceAll("-", " ")
		.split(/\s+/)
		.filter((token) => token.length)
}

function isVoieShaped(s: string): boolean {
	const first = foldVoieTokens(s)[0]

	if (!first) return false

	return isFrenchStreetWord(first) || FR_GENEROUS_VOIE_TOKENS.has(first)
}

function pushCandidate(list: string[], v: string | null, cap: number): void {
	const t = v?.trim()

	if (t && list.length < cap && !list.includes(t)) {
		list.push(t)
	}
}

/**
 * Adds a street centroid to a street-only query when no address-point or interpolated coordinate exists.
 */
export function applyStreetCentroid(
	roots: AddressNode[],
	raw: string,
	provider: (country: string) => StreetCentroidLookup | null | undefined,
	hints: readonly string[]
): void {
	let streetNode: AddressNode | null = null
	let houseNumber = false
	let postcode: string | null = null

	const adminValues: string[] = []
	const resolvedCountries: string[] = []

	for (const n of walkNodes(roots)) {
		if (n.tag === "house_number") {
			houseNumber = true
		}

		if (n.tag === "street" && !streetNode) {
			streetNode = n
		}

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

	if (houseNumber) return

	const countries: string[] = []

	for (const c of [...hints, ...resolvedCountries]) {
		const cc = c?.trim().toLowerCase()

		if (cc && !countries.includes(cc)) {
			countries.push(cc)
		}
	}

	const lookups = countries.map((c) => provider(c)).filter((l): l is StreetCentroidLookup => l != null)

	if (!lookups.length) return

	const rawSegments = TextSpliterator.from(raw, { delimiter: "," }).toArray()

	const CAP = 5

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
			let matchedCommune: string | null = null

			for (let i = 0; !hit && i < communes.length; i++) {
				hit = lookup.find({ street, locality: communes[i]! })

				if (hit) {
					matchedCommune = communes[i] ?? null
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
