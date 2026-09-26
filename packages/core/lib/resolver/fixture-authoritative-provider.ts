/**
 * @copyright Sister Software
 * @author Teffen Ellis, et al.
 * @license AGPL-3.0
 *
 *   In-memory fixture implementation of the authoritative-provider interface — synthetic addresses, synthetic
 *   identifiers, zero network — shipped beside the interface the way `@mailwoman/core/api/test-clocks` ships
 *   beside `APIClient`, so every consumer package exercises the boundary against the same reference
 *   implementation instead of hand-rolled mocks that drift.
 *
 *   The fixture matches on the query's normalized form or a declared component value, deliberately simple
 *   string keys because it tests the threading of provider answers through result surfaces rather than
 *   matching quality; no fixture row may carry licensed data, and synthetic uprn-shaped identifiers use the
 *   reserved 0-prefix range no real uprn occupies.
 */

import {
	type AuthoritativeMatch,
	type AuthoritativeProvider,
	type AuthoritativeQuery,
	type AuthoritativeResponse,
	AuthoritativeResponseStatus,
} from "#resolver/authoritative-provider"

/**
 * One fixture rule: when `matchOn` is found in the query's normalized form as a
 * case-insensitive substring, answer with `response`.
 */
export interface FixtureAuthoritativeRule {
	matchOn: string
	response: AuthoritativeResponse
}

export interface FixtureAuthoritativeProviderOptions {
	/**
	 * Rules checked in order with the first hit answering; no hit is a `refused` response, because
	 * a fixture that silently "matches no rule" is indistinguishable from one that was never consulted.
	 */
	rules: ReadonlyArray<FixtureAuthoritativeRule>
	/**
	 * Records every query the fixture receives, so a test can assert the provider was
	 * or was not consulted and with what evidence.
	 */
	log?: AuthoritativeQuery[]
}

const FIXTURE_ATTRIBUTION = "Synthetic fixture data — not derived from any licensed source"

/**
 * Build a fixture provider from rules; the returned provider is pure and synchronous
 * under the hood, and the async signature is the interface's.
 */
export function createFixtureAuthoritativeProvider(
	options: FixtureAuthoritativeProviderOptions
): AuthoritativeProvider {
	return {
		name: "fixture",
		async lookup(query: AuthoritativeQuery): Promise<AuthoritativeResponse> {
			options.log?.push(query)

			const haystack = query.normalizedQuery.toLowerCase()
			const rule = options.rules.find((candidate) => haystack.includes(candidate.matchOn.toLowerCase()))

			if (rule) return rule.response

			return {
				status: AuthoritativeResponseStatus.Refused,
				matches: [],
				attribution: FIXTURE_ATTRIBUTION,
			}
		},
	}
}

/**
 * A ready-made exact match for one synthetic premise, for the common one-rule test,
 * with the uprn-shaped identifier in a 0-prefixed range no real uprn occupies.
 */
export function fixtureExactMatch(overrides: Partial<AuthoritativeMatch> = {}): AuthoritativeResponse {
	return {
		status: AuthoritativeResponseStatus.Matched,
		matches: [
			{
				providerPlaceID: "fixture-place-0001",
				objectIDs: { uprn: "000000000001" },
				canonicalFields: {
					ADDRESS: "1 Example Terrace, Testtown, TT1 1TT",
					POSTCODE: "TT1 1TT",
				},
				latitude: 51.0001,
				longitude: -0.0001,
				coordinatePrecision: "rooftop",
				matchStatus: "exact",
				providerScore: 1,
				...overrides,
			},
		],
		attribution: FIXTURE_ATTRIBUTION,
		license: "fixture-terms-v1",
		datasetVersion: "fixture-2026-08",
	}
}
