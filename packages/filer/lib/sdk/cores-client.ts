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
 *   Task 9 stopped at a gate on exactly that. `apps.fcc.gov/cores/searchDetail.do` — the HTML detail page —
 *   answers 200 from the same host with an ordinary descriptive User-Agent, no browser spoofing and no
 *   credentials. That is what this client uses.
 *
 *   **What it does NOT give, correcting the 3a plan.** That plan justified CORES as a FAMILY-edge source
 *   because the JSON API returns parent and subsidiary names. This HTML page carries no parent,
 *   subsidiary, related or affiliate field of any kind. CORES is a CORROBORATION source here — a second
 *   name, a brand, an address — not a source of ownership edges. Do not write a family edge from it.
 *
 *   **No HTML-parser dependency**, matching `exhibit21.ts`: this workspace has none, and the registration
 *   page is a single flat `<th>`/`<td>` table. Parsing reuses `exhibit21.ts`'s own `stripTags` /
 *   `decodeEntities` / `normalizeWhitespace` rather than growing a second normalizer.
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
import { $private } from "@mailwoman/core/env"
import { ResourceError } from "@mailwoman/core/errors"
import { dataRootPath } from "@mailwoman/core/utils"

import { isFRN, type FRN } from "#frn"
import { decodeEntities, normalizeWhitespace, stripTags } from "#sdk/exhibit21"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

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

const CORES_BASE_URL = "https://apps.fcc.gov"

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

/**
 * One CORES registration record, exactly as the detail page states it. Every field is optional because the page omits a
 * row rather than emitting an empty one, and an absent contact fax says nothing about the entity.
 *
 * No field here is interpreted, derived or classified — see the file header's note 2 on why Nexus's name-sniffing
 * classification is not carried over.
 */
export interface CORESRegistration {
	frn: FRN
	/**
	 * The legal name the entity registered under. NOT necessarily the name anyone uses for it: FRN `0001753557` registers
	 * as `"Knology Total Communications, Inc."` while operating as WOW!.
	 */
	entityName?: string
	/**
	 * CORES's own entity-type string, verbatim (e.g. `"Private Sector , Corporation"` — the stray space before the comma
	 * is in the source). Deliberately not parsed into a union: the vocabulary is unenumerated and a caller that needs a
	 * classification should corroborate rather than trust a string split.
	 */
	entityType?: string
	/**
	 * The organization the registered contact belongs to. In practice this is where the BRAND appears when it differs
	 * from the legal name — `"WOW! Internet, Cable and Phone"` against a legal name of `"Knology Total Communications,
	 * Inc."` — which makes it a genuinely independent name surface, not a duplicate of `entityName`.
	 */
	contactOrganization?: string
	contactName?: string
	contactPosition?: string
	/**
	 * The contact's postal address as one string. CORES renders it across several lines and appends `"United States"`;
	 * both are collapsed here, the country suffix included, since every record in scope is domestic and keeping it adds a
	 * token every address-matching pass would have to strip again.
	 */
	contactAddress?: string
	contactEmail?: string
	contactPhone?: string
	contactFax?: string
	/**
	 * Raw `MM/DD/YYYY hh:mm:ss AM/PM` timestamps exactly as served. NOT parsed to a `Date` here — the same discipline
	 * `Form499Row.lastFiledAt` follows, so a caller that needs a temporal value performs (and can validate) its own
	 * conversion rather than inheriting a silent one.
	 */
	registrationDate?: string
	lastUpdated?: string
}

const TABLE_ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
const HEADER_CELL_PATTERN = /<th[^>]*>([\s\S]*?)<\/th>/i
const DATA_CELL_PATTERN = /<td[^>]*>([\s\S]*?)<\/td>/i

/**
 * Maps a CORES row label to its {@linkcode CORESRegistration} field. Keyed on the label reduced to lowercase letters and
 * digits only, so `"ContactPhone:"` and `"Contact Phone:"` — the page ships both spellings, the phone and fax rows
 * having lost their space — land on one key without a separate alias per variant.
 */
const FIELD_BY_LABEL: Record<string, keyof CORESRegistration> = {
	frn: "frn",
	registrationdate: "registrationDate",
	lastupdated: "lastUpdated",
	entityname: "entityName",
	entitytype: "entityType",
	contactorganization: "contactOrganization",
	contactposition: "contactPosition",
	contactname: "contactName",
	contactaddress: "contactAddress",
	contactemail: "contactEmail",
	contactphone: "contactPhone",
	contactfax: "contactFax",
}

function labelKey(text: string): string {
	return text.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

const HAS_LOWERCASE_PATTERN = /[a-z]/
const HAS_UPPERCASE_PATTERN = /[A-Z]/
const CASE_SENSITIVE_PUNCTUATION_PATTERN = /[:@()-]/

/**
 * Tokens that stay upper-case through the title-casing pass. Without these, `COMCAST CABLE COMMUNICATIONS, LLC`
 * title-cases to `… , Llc`, which is not a spelling anyone uses and would reach a product surface verbatim.
 *
 * Deliberately only initialisms whose conventional rendering IS all-caps. `Ltd`, `Corp` and `Inc` are absent because
 * their conventional rendering is title case, which the pass already produces. Matched on the token with trailing
 * punctuation stripped, so `LLC,` and `LLC.` both hit.
 */
const UPPERCASE_TOKENS = new Set(["llc", "lc", "lp", "llp", "pllc", "pc", "pa", "usa", "us", "dba", "inc's"])

/**
 * Title-case a value that arrived UNIFORMLY cased, and leave everything else alone — Nexus's `normalizeDataCell` idea,
 * kept because FCC data mixes `WINDSTREAM SERVICES LLC` with `Lumen Technologies Inc.` in the same column.
 *
 * The guard is what makes it safe. A string carrying BOTH cases is already deliberately cased and is returned
 * untouched, so `WOW! Internet, Cable and Phone` survives. A string containing `:`, `@`, `(`, `)` or `-` is left alone
 * too: those mark addresses, emails and phone numbers, where re-casing corrupts rather than tidies. Entity-form
 * initialisms are restored to upper case afterwards ({@linkcode UPPERCASE_TOKENS}).
 *
 * This is a display-level tidy, NOT a matching normalizer. Anything joining on these values must still go through
 * `canonicalizeOrganizationName` — re-casing does not fold `INC` and `Inc.` together.
 */
export function recaseUniform(value: string): string {
	if (CASE_SENSITIVE_PUNCTUATION_PATTERN.test(value)) return value

	const hasLower = HAS_LOWERCASE_PATTERN.test(value)
	const hasUpper = HAS_UPPERCASE_PATTERN.test(value)

	if (hasLower && hasUpper) return value

	if (!hasLower && !hasUpper) return value

	return value
		.toLowerCase()
		.replaceAll(/(^|\s|["'([])([a-z])/g, (_match, prefix: string, letter: string) => prefix + letter.toUpperCase())
		.replaceAll(/\S+/g, (token) =>
			UPPERCASE_TOKENS.has(token.toLowerCase().replaceAll(/[^a-z']/g, "")) ? token.toUpperCase() : token
		)
}

/**
 * Reduce one cell's raw HTML to its visible text — tags stripped, entities decoded, whitespace collapsed. Shares
 * `exhibit21.ts`'s helpers rather than growing a second normalizer in this workspace.
 */
function cellText(rawHTML: string): string {
	return normalizeWhitespace(decodeEntities(stripTags(rawHTML)))
}

/**
 * Parse a CORES `searchDetail.do` page into a {@linkcode CORESRegistration}.
 *
 * Returns `null` — never a stub record, and never a throw — when the page carries no recognizable registration table,
 * or when its `FRN:` row disagrees with the FRN that was requested. Both are ordinary: CORES serves a search form for
 * an unknown FRN, and an abstention here is a fact the caller counts, not an error it handles.
 *
 * **The FRN cross-check is the required part.** Without it a page served for the wrong entity — a redirect, a cached
 * response for a different query, a truncated document — would be attributed to the FRN that was asked for, which is a
 * false identity link written silently. The page states its own FRN; requiring the two to agree is free.
 */
export function parseCORESRegistration(frn: FRN, html: string): CORESRegistration | null {
	const fields: Partial<Record<keyof CORESRegistration, string>> = {}

	for (const rowMatch of html.matchAll(TABLE_ROW_PATTERN)) {
		const rowHTML = rowMatch[1]!
		const label = HEADER_CELL_PATTERN.exec(rowHTML)?.[1]

		if (!label) continue

		const field = FIELD_BY_LABEL[labelKey(cellText(label))]

		if (!field) continue

		const value = cellText(DATA_CELL_PATTERN.exec(rowHTML)?.[1] ?? "")

		if (value) {
			fields[field] = value
		}
	}

	if (!fields.entityName && !fields.contactOrganization) return null

	if (fields.frn && fields.frn !== frn) return null

	const registration: CORESRegistration = { frn }

	for (const [field, value] of Object.entries(fields)) {
		if (field === "frn") continue

		// Timestamps and free-text contact details keep their source casing; only the NAME surfaces get the
		// uniform-case tidy, since they are what a human reads and what a display layer renders.
		registration[field as Exclude<keyof CORESRegistration, "frn">] =
			field === "entityName" || field === "contactOrganization" || field === "contactName"
				? recaseUniform(value)
				: value
	}

	return registration
}

/**
 * The slice of {@linkcode CORESClient} a caller needs to fetch one registration — one method, so a test can substitute a
 * trivial stub instead of building an axios harness. Mirrors `exhibit21.ts`'s `SECDocumentClient` precedent, and a real
 * `createCORESClient()` instance satisfies it structurally.
 */
export interface CORESDocumentClient {
	getDocument(input: string | URL): Promise<string>
}

/**
 * The detail-page URL for one FRN.
 */
export function coresDetailURL(frn: FRN): string {
	return `${CORES_BASE_URL}/cores/searchDetail.do?frn=${frn}`
}

/**
 * Fetch and parse one FRN's registration. `null` when CORES has no record to state — see
 * {@linkcode parseCORESRegistration} for when that happens and why it is not an error.
 */
export async function fetchCORESRegistration(client: CORESDocumentClient, frn: FRN): Promise<CORESRegistration | null> {
	if (!isFRN(frn)) {
		throw ResourceError.from(400, `fetchCORESRegistration: invalid FRN ${JSON.stringify(frn)}`, "cores", "request")
	}

	return parseCORESRegistration(frn, await client.getDocument(coresDetailURL(frn)))
}

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
	 * Axios overrides, merged over this client's defaults. The test seam — every test passes an `adapter` here so no test
	 * performs a live request. Overriding `headers` wholesale drops the User-Agent, so don't.
	 */
	axios?: APIClientConfig["axios"]
}

export interface CORESClientConfig extends APIClientConfig {
	userAgent: string
}

/**
 * Only a non-empty string body is worth persisting: every CORES response is an HTML document, so an empty body is a
 * truncated fetch rather than a legitimately empty record. There is no Axios-level parse step on a text response to
 * lean on, which makes this the only gate between a truncated page and a cache entry.
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
