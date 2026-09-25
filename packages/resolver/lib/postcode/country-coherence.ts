/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { candidateSystemsForPostcode } from "@mailwoman/codex"
import { firstNodeWhere, walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

/**
 * Sets the default maximum distance, in kilometres, between a postcode
 * and a locality for them to count as consistent.
 *
 * Verdicts were unchanged between 15 and 50 km, so the value is not finely tuned.
 */
export const POSTCODE_COUNTRY_COHERENCE_THRESHOLD_KM = 25

/**
 * Names which part of the address justified a country-scope verdict.
 *
 * - `pair`: the postcode and the locality both resolve in the country, within the threshold distance.
 * - `locality`: the locality exists in exactly one country, and no postcode in that country contradicts it.
 * - `postcode`: the postcode exists in exactly one country, and no gazetteer knows the locality.
 */
export type PostcodeCountryScopeEvidence = "pair" | "locality" | "postcode"

/**
 * A country in which the address's own evidence is geographically consistent.
 */
export interface PostcodeCountryScope {
	/**
	 * The upper-case ISO 3166-1 alpha-2 country code.
	 */
	country: string

	/**
	 * The postcode the verdict was reached on.
	 */
	postcode: string

	/**
	 * The locality the verdict was reached on.
	 */
	locality: string

	/**
	 * Which evidence carried the verdict.
	 */
	evidence: PostcodeCountryScopeEvidence

	/**
	 * The distance in kilometres between the postcode point and the nearest
	 * same-named locality, never above the threshold.
	 *
	 * It is present only for `pair` evidence, because a single-sided verdict has no
	 * second point, and a `0` would claim an agreement nobody tested.
	 */
	distanceKm?: number

	/**
	 * The postcode place that anchored the verdict, absent for `locality` evidence.
	 */
	postcodePlace?: ResolvedPlace

	/**
	 * The locality place that anchored the verdict, absent for `postcode` evidence.
	 */
	localityPlace?: ResolvedPlace
}

/**
 * Configures {@linkcode findPostcodeCountryScope} with the postcode,
 * the caller's default country, and optional overrides.
 */
export interface PostcodeCountryScopeOpts {
	/**
	 * The address's postcode, which callers should take from the resolver's own pre-scan
	 * so this pass and the walk agree on it.
	 */
	postcode: string

	/**
	 * The country the caller's default would hard-filter to, or `undefined` when no default is in force.
	 *
	 * Without a default, only the `pair` rung runs, and the pass abstains
	 * unless exactly one country qualifies.
	 */
	defaultCountry: string | undefined

	/**
	 * The consistency radius in kilometres, defaulting to {@link POSTCODE_COUNTRY_COHERENCE_THRESHOLD_KM}.
	 */
	thresholdKm?: number

	/**
	 * Upper-case ISO 3166-1 alpha-2 codes that replace the postcode-shape half of the
	 * candidate countries, such as the shape-coherence pass's intersection.
	 *
	 * It cannot narrow the other half, the countries whose gazetteer holds this postcode,
	 * and every candidate still has to pass the pair test.
	 */
	candidateSystems?: readonly string[]
}

function hasCoord(p: ResolvedPlace): boolean {
	return p.lat !== 0 || p.lon !== 0
}

const MAX_LOCALITY_VALUES = 3

/**
 * Returns up to three distinct locality values in document order, listing every
 * `locality` before any `dependent_locality`.
 *
 * Document order matters because the first-written locality is the one the address is about.
 */
export function localityValuesInDocumentOrder(roots: readonly AddressNode[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()

	for (const tag of ["locality", "dependent_locality"] as const) {
		collectInDocumentOrder(roots, tag, out, seen)
	}

	return out.slice(0, MAX_LOCALITY_VALUES)
}

/**
 * Returns the first of {@link localityValuesInDocumentOrder}, which is the locality the address is about.
 */
export function firstLocalityValue(roots: readonly AddressNode[]): string | undefined {
	return localityValuesInDocumentOrder(roots)[0]
}

function collectInDocumentOrder(nodes: readonly AddressNode[], tag: string, out: string[], seen: Set<string>): void {
	for (const n of nodes) {
		if (n.tag === tag && n.value.trim().length) {
			const value = n.value.trim()
			const key = value.toLowerCase()

			if (!seen.has(key)) {
				seen.add(key)
				out.push(value)
			}
		}

		collectInDocumentOrder(n.children, tag, out, seen)
	}
}

const POSTCODE_HOLDER_FETCH = 20
const LOCALITY_HOLDER_FETCH = 30

const MAX_CANDIDATE_COUNTRIES = 12

async function countriesHolding(
	backend: ResolverBackend,
	text: string,
	placetype: "postalcode" | "locality",
	limit: number,
	opts?: { primaryOnly?: boolean }
): Promise<Map<string, ResolvedPlace>> {
	const out = new Map<string, ResolvedPlace>()

	let hits: ResolvedPlace[]

	try {
		hits = await backend.findPlace({ text, placetype, limit, ...(opts?.primaryOnly ? { primaryOnly: true } : {}) })
	} catch {
		return out
	}

	for (const hit of hits) {
		const country = hit.country?.trim().toUpperCase()

		if (!country || hit.exactMatch === false || !hasCoord(hit)) continue

		if (!out.has(country)) {
			out.set(country, hit)
		}
	}

	return out
}

async function coherenceIn(
	country: string,
	postcode: string,
	locality: string,
	backend: ResolverBackend,
	thresholdKm: number,
	knownPostcodePlace?: ResolvedPlace
): Promise<{ postcodePlace: ResolvedPlace; localityPlace: ResolvedPlace; distanceKm: number } | null> {
	let postcodePlace = knownPostcodePlace

	if (!postcodePlace) {
		let postcodeHits: ResolvedPlace[]

		try {
			postcodeHits = await backend.findPlace({ text: postcode, placetype: "postalcode", country, limit: 3 })
		} catch {
			return null
		}

		postcodePlace = postcodeHits.find(hasCoord)
	}

	if (!postcodePlace) return null

	let localityHits: ResolvedPlace[]

	try {
		localityHits = await backend.findPlace({ text: locality, placetype: "locality", country, limit: 5 })
	} catch {
		return null
	}

	let best: { localityPlace: ResolvedPlace; distanceKm: number } | null = null

	for (const candidate of localityHits) {
		if (!candidate.exactMatch || !hasCoord(candidate)) continue
		const distanceKm = haversineKm(postcodePlace.lat, postcodePlace.lon, candidate.lat, candidate.lon)

		if (distanceKm > thresholdKm) continue

		if (!best || distanceKm < best.distanceKm) {
			best = { localityPlace: candidate, distanceKm }
		}
	}

	return best ? { postcodePlace, ...best } : null
}

/**
 * Finds the one country, other than the caller's default, in which the address's
 * postcode and locality are consistent.
 *
 * It returns `null` when the default country is already consistent, when the address
 * names a country, or when more than one alternative qualifies.
 */
export async function findPostcodeCountryScope(
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	opts: PostcodeCountryScopeOpts
): Promise<PostcodeCountryScope | null> {
	const postcode = opts.postcode.trim()
	const defaultCountry = opts.defaultCountry?.trim().toUpperCase() || undefined

	if (!postcode) return null

	if (firstNodeWhere(roots, (n) => n.tag === "country" && n.value.trim())) return null

	const localities = localityValuesInDocumentOrder(roots)

	if (!localities.length) return null

	const thresholdKm = opts.thresholdKm ?? POSTCODE_COUNTRY_COHERENCE_THRESHOLD_KM

	if (defaultCountry) {
		for (const locality of localities) {
			if (await coherenceIn(defaultCountry, postcode, locality, backend, thresholdKm)) return null
		}
	}

	const pcHolders = await countriesHolding(backend, postcode, "postalcode", POSTCODE_HOLDER_FETCH)

	const shapeSystems = (
		opts.candidateSystems ?? candidateSystemsForPostcode(postcode).map((system) => system.toUpperCase())
	).map((country) => country.trim().toUpperCase())

	const candidates = [...new Set([...shapeSystems, ...pcHolders.keys()])]
		.filter((country) => country !== defaultCountry)
		.slice(0, MAX_CANDIDATE_COUNTRIES)

	for (const locality of localities) {
		const coherent: PostcodeCountryScope[] = []

		for (const country of candidates) {
			const hit = await coherenceIn(country, postcode, locality, backend, thresholdKm, pcHolders.get(country))

			if (hit) {
				coherent.push({ country, postcode, locality, evidence: "pair", ...hit })
			}
		}

		if (coherent.length === 1) return coherent[0]!

		if (coherent.length > 1) return null
	}

	if (!defaultCountry) return null

	if (pcHolders.has(defaultCountry)) return null

	let anyDomestic = false
	let anyLocalityKnown = false
	const verdicts = new Map<string, PostcodeCountryScope>()

	for (const locality of localities) {
		if (await holdsLocality(backend, locality, defaultCountry)) {
			anyDomestic = true

			continue
		}

		const locHolders = await countriesHolding(backend, locality, "locality", LOCALITY_HOLDER_FETCH, {
			primaryOnly: true,
		})

		if (locHolders.size) {
			anyLocalityKnown = true
		}

		if (locHolders.size !== 1) continue

		const [country, localityPlace] = [...locHolders.entries()][0]!
		const ownPostcode = pcHolders.get(country)

		const contradicted =
			ownPostcode !== undefined &&
			haversineKm(ownPostcode.lat, ownPostcode.lon, localityPlace.lat, localityPlace.lon) > thresholdKm

		if (country !== defaultCountry && !contradicted && !verdicts.has(country)) {
			verdicts.set(country, { country, postcode, locality, evidence: "locality", localityPlace })
		}
	}

	if (verdicts.size === 1) return [...verdicts.values()][0]!

	if (verdicts.size > 1) return null

	if (!anyDomestic && !anyLocalityKnown && pcHolders.size === 1) {
		const [country, postcodePlace] = [...pcHolders.entries()][0]!

		if (country !== defaultCountry) {
			return { country, postcode, locality: localities[0]!, evidence: "postcode", postcodePlace }
		}
	}

	return null
}

async function holdsLocality(backend: ResolverBackend, locality: string, country: string): Promise<boolean> {
	try {
		const hits = await backend.findPlace({ text: locality, placetype: "locality", country, limit: 3 })

		return hits.some((hit) => hit.exactMatch && hasCoord(hit))
	} catch {
		return true
	}
}

/**
 * Records an adopted country scope and its evidence in the `metadata` of the
 * tree's postcode and locality nodes.
 */
export function stampPostcodeCountryScope(roots: readonly AddressNode[], scope: PostcodeCountryScope): void {
	for (const n of walkNodes(roots)) {
		if (n.tag !== "postcode" && n.tag !== "locality" && n.tag !== "dependent_locality") continue

		n.metadata = {
			...n.metadata,
			postcode_country_scope: scope.country,

			postcode_country_scope_evidence: scope.evidence,

			...(scope.distanceKm !== undefined ? { postcode_country_scope_km: scope.distanceKm } : {}),
		}
	}
}
