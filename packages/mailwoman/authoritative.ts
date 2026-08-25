/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Threads a configured authoritative provider's answer onto a geocode result (#1901). The block is
 *   ADDITIVE and SEPARATE: the provider's assertions ride beside Mailwoman's own answer, and nothing
 *   here rewrites the open result's coordinate, components, or tier — a consumer that wants the
 *   provider's identity reads the block and decides for itself. That separation is what makes the
 *   byte-equivalence guarantee trivial: with no provider configured, this module is never called and
 *   the result is the one every caller already gets.
 *
 *   A provider that THROWS is a transport failure (network, auth, timeout) and is reported as
 *   `status: "transport_error"` with the message — never silently dropped, because a dropped failure
 *   is indistinguishable from "the provider was not configured", and that is the
 *   measurement-boundary lie this repository keeps finding.
 */

import type {
	AuthoritativeMatch,
	AuthoritativeProvider,
	AuthoritativeQuery,
	AuthoritativeQueryComponent,
} from "@mailwoman/core/resolver"
import type { ComponentTag } from "@mailwoman/core/types"

/**
 * One provider match on the wire — the snake_case projection of {@link AuthoritativeMatch}, field for field. Absent
 * fields were absent from the provider's answer; nothing is defaulted in. Unexported: consumers reach it as
 * `AuthoritativeAssertion["matches"]`, and the export-hygiene guard holds the surface to actual importers.
 */
interface AuthoritativeAssertionMatch {
	provider_place_id: string
	object_ids?: Record<string, string>
	canonical_fields?: Record<string, string>
	lat?: number
	lon?: number
	precision?: string
	match_status: "exact" | "approximate"
	provider_score?: number
}

/**
 * The result-level block. `status` is the response status plus `transport_error`; `matches` is present exactly when the
 * provider returned candidates (one for `matched`, all of them in the provider's order for `ambiguous`).
 */
export interface AuthoritativeAssertion {
	provider: string
	status: "matched" | "ambiguous" | "refused" | "transport_error"
	matches?: AuthoritativeAssertionMatch[]
	attribution?: string
	license?: string
	retrieved_at?: string
	dataset_version?: string
	/**
	 * `transport_error` only: the thrown message, verbatim.
	 */
	error?: string
}

/**
 * The slice of a geocode result this module reads to build the provider's query. Structural, so the helper never
 * imports the result type and the dependency stays one-way.
 */
export interface AuthoritativeEvidence {
	locality: string | null
	region: string | null
	postcode: string | null
	house_number: string | null
	street: string | null
	venue: string | null
	dependent_locality: string | null
	unit: string | null
	countryCode: string | null
}

const EVIDENCE_TAGS: ReadonlyArray<[keyof AuthoritativeEvidence, ComponentTag]> = [
	["venue", "venue"],
	["house_number", "house_number"],
	["street", "street"],
	["unit", "unit"],
	["dependent_locality", "dependent_locality"],
	["locality", "locality"],
	["region", "region"],
	["postcode", "postcode"],
]

/**
 * Build the provider query from the assembled result's components. Spans are deliberately absent here — the flat result
 * no longer carries them, and the contract marks them optional for exactly this assembly.
 */
export function authoritativeQueryFrom(
	rawQuery: string,
	normalizedQuery: string,
	evidence: AuthoritativeEvidence,
	locale?: string
): AuthoritativeQuery {
	const components: AuthoritativeQueryComponent[] = []

	for (const [field, tag] of EVIDENCE_TAGS) {
		const value = evidence[field]

		if (typeof value === "string" && value.length) {
			components.push({ tag, value })
		}
	}

	return {
		rawQuery,
		normalizedQuery,
		components,
		...(evidence.countryCode ? { countryCode: evidence.countryCode } : {}),
		...(locale ? { locale } : {}),
	}
}

function projectMatch(match: AuthoritativeMatch): AuthoritativeAssertionMatch {
	return {
		provider_place_id: match.providerPlaceID,
		...(match.objectIDs ? { object_ids: { ...match.objectIDs } } : {}),
		...(match.canonicalFields ? { canonical_fields: { ...match.canonicalFields } } : {}),
		...(match.latitude !== undefined ? { lat: match.latitude } : {}),
		...(match.longitude !== undefined ? { lon: match.longitude } : {}),
		...(match.coordinatePrecision ? { precision: match.coordinatePrecision } : {}),
		match_status: match.matchStatus,
		...(match.providerScore !== undefined ? { provider_score: match.providerScore } : {}),
	}
}

/**
 * Consult the provider and project its answer to the wire block. Never throws: a thrown lookup comes back as the
 * `transport_error` block so the geocode result survives a provider outage intact.
 */
export async function consultAuthoritativeProvider(
	provider: AuthoritativeProvider,
	query: AuthoritativeQuery
): Promise<AuthoritativeAssertion> {
	try {
		const response = await provider.lookup(query)

		return {
			provider: provider.name,
			status: response.status,
			...(response.matches.length ? { matches: response.matches.map(projectMatch) } : {}),
			...(response.attribution ? { attribution: response.attribution } : {}),
			...(response.license ? { license: response.license } : {}),
			...(response.retrievedAt ? { retrieved_at: response.retrievedAt } : {}),
			...(response.datasetVersion ? { dataset_version: response.datasetVersion } : {}),
		}
	} catch (error) {
		return {
			provider: provider.name,
			status: "transport_error",
			error: (error as Error).message,
		}
	}
}
