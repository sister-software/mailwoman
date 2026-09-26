/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Threads a configured authoritative provider's answer onto a geocode result as an additive, separate block — no code here rewrites the open result's coordinate, components, or tier — and a provider that throws is reported as `status: "transport_error"` with the message rather than silently dropped, because a dropped failure is indistinguishable from "the provider was not configured".
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type {
	AuthoritativeMatch,
	AuthoritativeProvider,
	AuthoritativeQuery,
	AuthoritativeQueryComponent,
} from "@mailwoman/core/resolver"

/**
 * The snake_case wire projection of {@link AuthoritativeMatch}, field for field,
 * with no field defaulted in when the provider's answer omitted it.
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
 * The result-level block: `status` is the provider's response status plus `transport_error`,
 * and `matches` is present exactly when the provider returned candidates —
 * one for `matched`, all of them in the provider's order for `ambiguous`.
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
 * The subset of a geocode result this module reads: structural, so the helper never
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
 * Builds the provider query from the assembled result's components; spans are
 * deliberately absent, both because the flat result no longer carries them and
 * because the interface marks them optional for exactly this assembly.
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
 * Consults the provider and projects its answer to the wire block, never throwing:
 * a thrown lookup comes back as the `transport_error` block so the last geocode
 * answer remains available after a provider outage.
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
