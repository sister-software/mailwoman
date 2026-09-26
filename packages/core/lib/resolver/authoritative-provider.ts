/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authoritative-provider interface: a typed boundary for handing a structured query to an external
 *   reference service and carrying the provider's identity, licensing, and provenance back through the result
 *   without the provider's assertions and Mailwoman's inferences ever blurring.
 *
 *   Absence stays absent (a provider that does not expose a field leaves it `undefined`, never `false`, `0`
 *   or `""`); refusal and ambiguity are first-class outcomes rather than degenerate matches; provider
 *   assertions never overwrite Mailwoman's own answer, which is carried beside the response for the consumer
 *   to choose from; and no provider product names appear here, because product-specific mapping lives in an
 *   adapter package.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

/**
 * One parsed component as the provider receives it: the tag, the surface text, and the span it came from.
 */
export interface AuthoritativeQueryComponent {
	tag: ComponentTag
	value: string
	/**
	 * Character offsets into {@link AuthoritativeQuery.normalizedQuery},
	 * absent for components assembled from multiple spans.
	 */
	start?: number
	end?: number
}

/**
 * The structured evidence Mailwoman hands to a provider — everything the pipeline
 * already produced, so an adapter never re-parses.
 */
export interface AuthoritativeQuery {
	rawQuery: string
	normalizedQuery: string
	components: ReadonlyArray<AuthoritativeQueryComponent>
	/**
	 * ISO 3166-1 alpha-2, absent when the pipeline could not commit to one.
	 */
	countryCode?: string
	/**
	 * The caller's locale hint (BCP 47), when declared.
	 */
	locale?: string
	/**
	 * Mailwoman's own confidence in the parse, [0, 1], where absent means unmeasured rather than zero.
	 */
	parseConfidence?: number
}

/**
 * How the provider characterized one returned candidate.
 */
export const AuthoritativeMatchStatus = {
	Exact: "exact",
	Approximate: "approximate",
} as const

export type AuthoritativeMatchStatus = (typeof AuthoritativeMatchStatus)[keyof typeof AuthoritativeMatchStatus]

/**
 * One place the provider asserted, with every field carried verbatim as the
 * provider's claim rather than a Mailwoman inference.
 */
export interface AuthoritativeMatch {
	/**
	 * The provider's stable identifier within its own namespace.
	 */
	providerPlaceID: string
	/**
	 * Authoritative object identifiers by scheme, lowercase keys owned by the adapter,
	 * omitted when the provider supplies none.
	 */
	objectIDs?: Readonly<Record<string, string>>
	/**
	 * Canonical address fields as the provider returned them, keyed by the provider's own names
	 * and deliberately not remapped to {@link ComponentTag}, because a lossy remap would
	 * overwrite the assertion this interface exists to preserve.
	 */
	canonicalFields?: Readonly<Record<string, string>>
	latitude?: number
	longitude?: number
	/**
	 * The provider's stated precision or tier for the coordinate, in the provider's own vocabulary,
	 * because the resolver's tier taxonomy does not apply to an assertion Mailwoman did not make.
	 */
	coordinatePrecision?: string
	matchStatus: AuthoritativeMatchStatus
	/**
	 * The provider's own match score, provider-defined in scale and ordinal only.
	 */
	providerScore?: number
}

/**
 * The overall shape of a provider's answer, where `matches` is non-empty exactly
 * when `status` is `matched` or `ambiguous` and an ambiguous response keeps every
 * candidate in the provider's order rather than collapsing to the first.
 */
export const AuthoritativeResponseStatus = {
	/**
	 * The provider committed to `matches[0]`, alone.
	 */
	Matched: "matched",
	/**
	 * The provider returned candidates it could not decide between, all of them here.
	 */
	Ambiguous: "ambiguous",
	/**
	 * The provider declined to answer, which is neither an error nor a miss: the provider spoke and said no.
	 */
	Refused: "refused",
} as const

export type AuthoritativeResponseStatus = (typeof AuthoritativeResponseStatus)[keyof typeof AuthoritativeResponseStatus]

export interface AuthoritativeResponse {
	status: AuthoritativeResponseStatus
	/**
	 * Empty exactly when `status` is `refused`.
	 */
	matches: ReadonlyArray<AuthoritativeMatch>
	/**
	 * Source attribution for downstream display, when the provider's terms require one.
	 */
	attribution?: string
	/**
	 * License or terms identifier for downstream display, carried so a consumer can keep
	 * provider-derived records under the provider's terms from the result alone.
	 */
	license?: string
	/**
	 * When the provider answered, ISO-8601, absent when the transport does not surface it.
	 */
	retrievedAt?: string
	/**
	 * The provider's dataset version or epoch, when it states one.
	 */
	datasetVersion?: string
}

/**
 * A configured authoritative provider with one asynchronous, backend-neutral method;
 * a thrown error is a transport failure, which is not a refusal, the same way the
 * resolver keeps a backend error apart from a miss.
 */
export interface AuthoritativeProvider {
	/**
	 * Stable provider name for provenance stamps, lowercase kebab and owned by the adapter.
	 */
	readonly name: string
	lookup(query: AuthoritativeQuery): Promise<AuthoritativeResponse>
}
