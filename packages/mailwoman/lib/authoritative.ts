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
	object_ids: Record<string, string> | null
	canonical_fields: Record<string, string> | null
	lat: number | null
	lon: number | null
	precision: string | null
	match_status: "exact" | "approximate"
	provider_score: number | null
}

/**
 * The result-level block: `status` is the provider's response status plus `transport_error`,
 * and `matches` is non-null exactly when the provider returned candidates —
 * one for `matched`, all of them in the provider's order for `ambiguous`.
 */
export interface AuthoritativeAssertion {
	provider: string
	status: "matched" | "ambiguous" | "refused" | "transport_error"
	matches: AuthoritativeAssertionMatch[] | null
	attribution: string | null
	license: string | null
	retrieved_at: string | null
	dataset_version: string | null
	/**
	 * `transport_error` only: the thrown message, verbatim.
	 */
	error: string | null
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
 * Builds the provider query from the assembled result's components.
 *
 * Spans are deliberately absent, both because the flat result no longer includes them
 * and because the interface marks them optional for exactly this assembly.
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
			components.push({ tag, value, start: null, end: null })
		}
	}

	return {
		rawQuery,
		normalizedQuery,
		components,
		countryCode: evidence.countryCode || null,
		locale: locale || null,
		parseConfidence: null,
	}
}

function projectMatch(match: AuthoritativeMatch): AuthoritativeAssertionMatch {
	return {
		provider_place_id: match.providerPlaceID,
		object_ids: match.objectIDs ? { ...match.objectIDs } : null,
		canonical_fields: match.canonicalFields ? { ...match.canonicalFields } : null,
		lat: match.latitude,
		lon: match.longitude,
		precision: match.coordinatePrecision || null,
		match_status: match.matchStatus,
		provider_score: match.providerScore,
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
			matches: response.matches.length ? response.matches.map(projectMatch) : null,
			attribution: response.attribution || null,
			license: response.license || null,
			retrieved_at: response.retrievedAt || null,
			dataset_version: response.datasetVersion || null,
			error: null,
		}
	} catch (error) {
		return {
			provider: provider.name,
			status: "transport_error",
			matches: null,
			attribution: null,
			license: null,
			retrieved_at: null,
			dataset_version: null,
			error: (error as Error).message,
		}
	}
}
