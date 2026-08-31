/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authoritative-provider contract (#1901): a typed boundary for handing a structured query to an
 *   external reference service — OS Places, an OS NGD-backed service, any national equivalent — and
 *   carrying the provider's identity, licensing, and provenance back through the result WITHOUT the
 *   provider's assertions and Mailwoman's inferences ever blurring.
 *
 *   Ground rules the shapes below enforce:
 *
 *   - **Absence stays absent.** A provider that does not expose a field leaves it `undefined`; nothing
 *     here normalizes absence into `false`, `0`, or `""`. A consumer that needs the distinction reads
 *     the optional directly.
 *   - **Refusal and ambiguity are first-class outcomes**, not degenerate matches: a refusal is a
 *     provider that declined to answer, an ambiguous response KEEPS every candidate, and neither is a
 *     parse failure or an open-gazetteer miss.
 *   - **Provider assertions never overwrite Mailwoman's own answer.** The response is carried BESIDE
 *     the open result; the consumer chooses which identity to act on.
 *   - **No provider product names in this module.** Product-specific mapping lives in an adapter
 *     package; these shapes are what every adapter maps INTO.
 */

import type { ComponentTag } from "#types/component"

/**
 * One parsed component as the provider receives it: the tag, the surface text, and where in the normalized query it
 * came from. Spans let a provider that scores per-field report which input characters each of its canonical fields
 * answers.
 */
export interface AuthoritativeQueryComponent {
	tag: ComponentTag
	value: string
	/**
	 * Character offsets into {@link AuthoritativeQuery.normalizedQuery}, when the pipeline still holds them. Absent for
	 * components assembled from multiple spans.
	 */
	start?: number
	end?: number
}

/**
 * The structured evidence Mailwoman hands to a provider — everything the pipeline already produced, so an adapter never
 * re-parses.
 */
export interface AuthoritativeQuery {
	/**
	 * The raw input as the caller supplied it.
	 */
	rawQuery: string
	/**
	 * The normalized form the parse ran on.
	 */
	normalizedQuery: string
	components: ReadonlyArray<AuthoritativeQueryComponent>
	/**
	 * ISO 3166-1 alpha-2, when inferred or declared. Absent when the pipeline could not commit to one.
	 */
	countryCode?: string
	/**
	 * The caller's locale hint (BCP 47), when one was declared.
	 */
	locale?: string
	/**
	 * Mailwoman's own confidence in the parse, [0, 1], when the decode produced one — an adapter may use it to choose
	 * between a strict and a fuzzy provider query. Absent means UNMEASURED, never zero.
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
 * One place the provider asserted. Every field is the PROVIDER'S claim, carried verbatim — nothing here is a Mailwoman
 * inference, which is exactly what makes the block auditable downstream.
 */
export interface AuthoritativeMatch {
	/**
	 * The provider's stable identifier for this object within its own namespace.
	 */
	providerPlaceID: string
	/**
	 * Authoritative object identifiers by scheme, e.g. `{ uprn: "100023336956" }`. Schemes are lowercase keys owned by
	 * the adapter; a provider that supplies none omits the field.
	 */
	objectIDs?: Readonly<Record<string, string>>
	/**
	 * Canonical address fields as the provider returned them, keyed by the provider's own field names. Deliberately NOT
	 * remapped to {@link ComponentTag}: a lossy remap would overwrite the assertion this contract exists to preserve. An
	 * adapter MAY additionally offer a mapped view; this field is the record.
	 */
	canonicalFields?: Readonly<Record<string, string>>
	latitude?: number
	longitude?: number
	/**
	 * The provider's stated precision or tier for the coordinate, in the provider's own vocabulary (e.g. a
	 * rooftop/parcel/centroid label). Verbatim — the resolver's own tier taxonomy does not apply to an assertion
	 * Mailwoman did not make.
	 */
	coordinatePrecision?: string
	matchStatus: AuthoritativeMatchStatus
	/**
	 * The provider's own match score, when it states one. Scale is provider-defined; ordinal only.
	 */
	providerScore?: number
}

/**
 * The overall shape of a provider's answer. `matches` is non-empty exactly when `status` is `matched` or `ambiguous`;
 * an ambiguous response carries EVERY candidate the provider returned, in the provider's order — collapsing to the
 * first would manufacture a certainty the provider refused.
 */
export const AuthoritativeResponseStatus = {
	/**
	 * The provider committed to one answer: `matches[0]`, alone.
	 */
	Matched: "matched",
	/**
	 * The provider returned candidates it could not decide between. All of them are here.
	 */
	Ambiguous: "ambiguous",
	/**
	 * The provider declined to answer — out of coverage, below its own confidence floor, or the query shape is outside
	 * its scope. NOT an error and NOT a miss: the provider spoke, and said no.
	 */
	Refused: "refused",
} as const

export type AuthoritativeResponseStatus = (typeof AuthoritativeResponseStatus)[keyof typeof AuthoritativeResponseStatus]

export interface AuthoritativeResponse {
	status: AuthoritativeResponseStatus
	/**
	 * Empty exactly when {@link status} is `refused`.
	 */
	matches: ReadonlyArray<AuthoritativeMatch>
	/**
	 * Source attribution suitable for downstream display, when the provider's terms require one.
	 */
	attribution?: string
	/**
	 * License or terms identifier suitable for downstream display (an SPDX id, a product terms name). Carried so a
	 * consumer can keep provider-derived records under the provider's terms without consulting anything outside the
	 * result.
	 */
	license?: string
	/**
	 * When the provider answered, ISO-8601. Absent when the transport does not surface it.
	 */
	retrievedAt?: string
	/**
	 * The provider's dataset version or epoch, when it states one.
	 */
	datasetVersion?: string
}

/**
 * A configured authoritative provider. One method, asynchronous, backend-neutral.
 *
 * A thrown error is a TRANSPORT failure (network, auth, timeout) and is the adapter's to surface — it is NOT a refusal,
 * which is a well-formed {@link AuthoritativeResponse} with `status: "refused"`. Consumers keep the two apart the same
 * way the resolver keeps a backend error apart from a miss.
 */
export interface AuthoritativeProvider {
	/**
	 * Stable provider name for provenance stamps (e.g. an adapter package's registered name). Lowercase kebab, owned by
	 * the adapter.
	 */
	readonly name: string
	lookup(query: AuthoritativeQuery): Promise<AuthoritativeResponse>
}
