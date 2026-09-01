/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Hostname handling shared by designated HTTP clients' allowlists.
 */

import { ResourceError } from "#errors/schema"

/**
 * A trailing dot makes a hostname fully qualified — `www.sec.gov.` and `www.sec.gov` reach the same server, but only
 * the latter is in an allowlist, and the WHATWG parser preserves the dot. Stripped before the lookup so the FQDN form
 * is admitted rather than rejected as an unknown host.
 */
export function canonicalHostname(url: URL): string {
	return url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname
}

/**
 * The status a refused request reports — the request itself is malformed for this client, not the upstream.
 */
const HTTP_BAD_REQUEST = 400

export interface AssertAllowedHostOptions {
	/**
	 * Exact hostnames this client may reach. Matching is a `Set` lookup, never a suffix check — `host.attacker.example`
	 * must not match, and an `.endsWith(...)`-style test would admit it.
	 */
	allowed: ReadonlySet<string>
	/**
	 * Names the factory in the refusal, e.g. `createSECClient`.
	 */
	scope: string
	/**
	 * The {@link ResourceError} source segment, e.g. `sec`.
	 */
	clientName: string
	/**
	 * Replaces the plain host list in the not-allowed refusal, e.g. `SEC EDGAR hosts (…)`.
	 */
	hostsDescription?: string
	/**
	 * The client's own sentence after the host list — why the list is what it is.
	 */
	hostNote: string
}

/**
 * Reject a URL a designated client must not send its identifying headers to: https only, allowlisted hosts only.
 *
 * @throws {ResourceError} With URN kind `request` — never transient, because re-issuing the identical URL can only fail
 *   identically.
 */
export function assertAllowedHost(url: URL, options: AssertAllowedHostOptions): void {
	if (url.protocol !== "https:") {
		throw ResourceError.from(
			HTTP_BAD_REQUEST,
			`${options.scope}: refusing to request "${url}" over ${url.protocol.replace(":", "")} — this client only ` +
				"sends requests over https, so the configured User-Agent (a contact address) is never sent in cleartext.",
			options.clientName,
			"request",
			"insecure-scheme"
		)
	}

	if (!options.allowed.has(canonicalHostname(url))) {
		throw ResourceError.from(
			HTTP_BAD_REQUEST,
			`${options.scope}: refusing to request "${url}" — this client only sends requests to ` +
				`${options.hostsDescription ?? [...options.allowed].join(", ")}. ${options.hostNote}`,
			options.clientName,
			"request",
			"host-not-allowed"
		)
	}
}
