/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC CORES entity-registration lookup — FRN → registered legal name, brand, address.
 *
 *   CORES (the Commission Registration System) is where an FRN's authoritative registration record lives:
 *   the legal name the entity registered under, the organization its contact works for (in practice the
 *   BRAND), a full postal address, an entity type, and registration/update timestamps.
 *
 *   **Why this is worth a client at all.** Form 499 gives one name per filer, free-text and inconsistently
 *   cased. CORES gives a SECOND, independently-maintained name and address for the same FRN. Record
 *   linkage across FCC data failed historically because there was one name surface and it was dirty; two
 *   surfaces keyed on the same identifier is corroboration. FRN `0001753557` is the worked example that
 *   makes the case: it registers as `"Knology Total Communications, Inc."`, its contact organization is
 *   `"WOW! Internet, Cable and Phone"`, and the operator knows it as WideOpenWest. No name-only join
 *   connects those three; the FRN does, and CORES is what supplies the other two spellings.
 *
 *   **Two endpoints, and this is the one that answers.** `data.fcc.gov/api/frn/getInfo` is the documented
 *   JSON "FRN Conversions" API and it returns 403 at the Akamai edge from the lab host (retested
 *   2026-08-07; a descriptive User-Agent does not change it, so the block is host/IP-based). The 3a plan's
 *   Task 9 stopped at a check on exactly that. `apps.fcc.gov/cores/searchDetail.do` — the HTML detail page —
 *   answers 200 from the same host with an ordinary descriptive User-Agent, no browser spoofing and no
 *   credentials. That is what this client uses.
 *
 *   **What it does NOT give, correcting the 3a plan.** That plan justified CORES as a FAMILY-edge source
 *   because the JSON API returns parent and subsidiary names. This HTML page carries no parent,
 *   subsidiary, related or affiliate field of any kind. CORES is a CORROBORATION source here — a second
 *   name, a brand, an address — not a source of ownership edges. Do not write a family edge from it.
 *
 *   **No HTML-parser dependency**, matching `exhibit21.ts`: this workspace has none, and the registration
 *   page is a single flat `<th>`/`<td>` table. Cell text is `@mailwoman/core/html/text`'s prose reading rather
 *   than a second normalizer grown in this workspace.
 *
 *   **Ported from Nexus's `sync/fcc/CORESClient.ts`** (relicense-by-copy), restructured onto
 *   {@linkcode APIClient} and deliberately narrowed in three places:
 *
 *   1. The Nexus original caught HTTP 500 and HTML-parse failure and returned a FABRICATED `Organization`
 *      with `registeredAt: new Date(0)` and a catch-all classification. An abstention that reads as a
 *      record is the failure class this repo has spent real effort removing; {@linkcode parseCORESRegistration}
 *      returns `null` and the caller decides.
 *   2. Nexus classified entities by substring-sniffing the name — `includes("CITY")` → municipal,
 *      `includes("RURAL")` → rural, any US state name → municipal. "Kansas City Telephone" is not a
 *      municipality. No classification happens here; the raw `entityType` CORES states is carried through
 *      verbatim and interpretation belongs to a caller that can corroborate it.
 *   3. Nexus ran the whole document through Prettier before parsing it, to normalize the markup. That is a
 *      formatter in a fetch path; the scan below tolerates the source markup as served.
 *
 *   The one Nexus idea kept wholesale is `normalizeDataCell`'s re-casing of UNIFORMLY-cased text — see
 *   {@linkcode recaseUniform}. FCC data is littered with `WINDSTREAM SERVICES LLC` beside
 *   `Lumen Technologies Inc.`, and the uniformly-cased guard is what stops it mangling `WOW!` or `IDT`.
 */

import {
	API_CLIENT_DEFAULTS,
	APIClient,
	assertAllowedHost,
	type APIClientConfig,
	type ClockLike,
} from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { dataRootPath } from "@mailwoman/core/data-root"

import { $private } from "#env"

// Re-exported so a caller branching on this client's failures needs exactly one import.

/**
 * Requests/second this client paces at by default.
 *
 * **CORES publishes no rate limit**, which is a reason for restraint rather than licence. SEC states 10/s and this
 * client sits far below that on an endpoint whose operator has said nothing: a full enrichment pass over the ~18.6k
 * FRNs in the Form 499 filer database takes about 78 minutes at this rate, and it is a once-per-vintage job whose
 * results are cached on disk. Raise it only with a reason better than impatience.
 */
export const CORES_DEFAULT_REQUESTS_PER_SECOND = 4

/**
 * Hard ceiling regardless of what a caller asks for. Not derived from a published policy — there isn't one — so it is
 * set where a sustained crawl still looks like a well-behaved client to an operator reading their access log.
 */
export const CORES_MAX_REQUESTS_PER_SECOND = 8

const MS_PER_SECOND = 1000

/**
 * How long a cached registration stays fresh. A CORES record changes when an entity updates its contact details — the
 * two records sampled on 2026-08-07 carried `Last Updated` timestamps from April and May 2026 — so this is a
 * slow-moving but genuinely mutable resource. Seven days keeps a multi-day build from re-fetching while still noticing
 * a change within a release cycle.
 */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const HTTP_OK = 200
const HTTP_MULTIPLE_CHOICES = 300

/**
 * The only host this client will send a request to. Matching is EXACT (a `Set` lookup on the hostname), never a suffix
 * check — `apps.fcc.gov.attacker.example` must not match, and an `.endsWith(".fcc.gov")` test would admit it. Mirrors
 * `sec-client.ts`'s allowlist rationale.
 */
const CORES_ALLOWED_HOSTS = new Set(["apps.fcc.gov"])

/**
 * Reject a URL this client must not send. Throws a {@linkcode ResourceError} whose URN kind is `request` — never
 * transient, since re-issuing the identical URL fails identically.
 */
function assertCORESHost(url: URL): void {
	assertAllowedHost(url, {
		allowed: CORES_ALLOWED_HOSTS,
		scope: "createCORESClient",
		clientName: "cores",
		hostNote:
			"Note that data.fcc.gov is NOT on this list: its documented FRN JSON API 403s at the Akamai edge from the " +
			"lab host, which is why this client uses the apps.fcc.gov detail page instead.",
	})
}

export { parseCORESRegistration, recaseUniform, type CORESRegistration } from "#sdk/cores/registration"

export { coresDetailURL, fetchCORESRegistration, type CORESDocumentClient } from "#sdk/cores/document"

/**
 * Options for {@linkcode createCORESClient}.
 */
export interface CreateCORESClientOptions {
	/**
	 * Descriptive User-Agent. CORES does not require one — unlike SEC, which 403s without it — so this never throws when
	 * unset. It is sent anyway because identifying a crawler to the operator of an unmetered public endpoint is the
	 * courtesy that keeps it unmetered. Defaults to `$private.FCC_CORES_USER_AGENT`, then `$private.SEC_EDGAR_USER_AGENT`
	 * (same contact address, already configured), then a package-identifying fallback.
	 */
	userAgent?: string
	/**
	 * Desired requests/second, clamped to `[1, CORES_MAX_REQUESTS_PER_SECOND]`. Defaults to
	 * {@linkcode CORES_DEFAULT_REQUESTS_PER_SECOND}.
	 */
	requestsPerSecond?: number
	clock?: ClockLike
	/**
	 * On-disk cache root. Defaults to `dataRootPath("fcc", "cores", "cache")`.
	 */
	cacheDir?: string
	cacheTTLMs?: number
	maxAttempts?: number
	baseRetryDelayMs?: number
	requestTimeoutMs?: number
	/**
	 * Axios overrides, merged over this client's defaults. The TEST INJECTION POINT — every test passes an `adapter` here
	 * so no test performs a live request. Overriding `headers` wholesale drops the User-Agent, so don't.
	 */
	axios?: APIClientConfig["axios"]
}

export interface CORESClientConfig extends APIClientConfig {
	userAgent: string
}

/**
 * Only a non-empty string body is worth persisting: every CORES response is an HTML document, so an empty body is a
 * truncated fetch rather than a legitimately empty record. There is no Axios-level parse step on a text response to
 * lean on, which makes this the only check between a truncated page and a cache entry.
 */
function isCacheableCORESBody(value: { data?: { data?: unknown } }): boolean {
	const body = value.data?.data

	return typeof body === "string" && body.length > 0
}

/**
 * An FCC CORES client. See the file header for why this reads the HTML detail page rather than the documented JSON API.
 */
export class CORESClient extends APIClient<CORESClientConfig> {
	/**
	 * Issue a `GET` against a full absolute CORES URL (https, on the allowed host only) and return the RAW response body
	 * as text, subject to the on-disk cache, the request pacer, and bounded retry.
	 *
	 * Text rather than JSON because the endpoint serves HTML; `responseType: "text"` tells Axios to hand the body back
	 * as-is rather than attempt to parse it.
	 */
	public async getDocument(input: string | URL): Promise<string> {
		const url = input instanceof URL ? input : new URL(input)

		assertCORESHost(url)

		const response = await this.fetch<string>({ url: url.toString(), responseType: "text" })

		return response.data
	}
}

/**
 * Create an FCC CORES client. Never throws for a missing User-Agent — CORES does not require one.
 */
export function createCORESClient(options: CreateCORESClientOptions = {}): CORESClient {
	const userAgent =
		options.userAgent ??
		$private.FCC_CORES_USER_AGENT ??
		$private.SEC_EDGAR_USER_AGENT ??
		"@mailwoman/filer (https://github.com/sister-software/mailwoman)"

	const requestsPerSecond = Math.max(
		1,
		Math.min(options.requestsPerSecond ?? CORES_DEFAULT_REQUESTS_PER_SECOND, CORES_MAX_REQUESTS_PER_SECOND)
	)

	return new CORESClient({
		displayName: "FCC CORES",
		userAgent,
		// Ceil for the same reason sec-client.ts ceils: a fractional interval puts the Nth grant at exactly
		// the window boundary, and sub-millisecond jitter tips it inside.
		minRequestIntervalMs: Math.ceil(MS_PER_SECOND / requestsPerSecond),
		retry: {
			maxAttempts: options.maxAttempts ?? API_CLIENT_DEFAULTS.maxAttempts,
			baseDelayMs: options.baseRetryDelayMs ?? API_CLIENT_DEFAULTS.baseRetryDelayMs,
		},
		clock: options.clock,
		caching: {
			storage: buildDiskStorage({
				directory: options.cacheDir ?? dataRootPath("fcc", "cores", "cache"),
				validate: isCacheableCORESBody,
			}),
			ttl: options.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS,
			interpretHeader: false,
			cachePredicate: { statusCheck: (status) => status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES },
		},
		axios: {
			headers: {
				"User-Agent": userAgent,
				"Accept-Encoding": "gzip, deflate",
			},
			timeout: options.requestTimeoutMs ?? API_CLIENT_DEFAULTS.requestTimeoutMs,
			responseType: "text",
			...options.axios,
		},
	})
}
