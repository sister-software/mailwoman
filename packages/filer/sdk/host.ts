/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Hostname handling shared by the filer HTTP clients' allowlists.
 */

/**
 * A trailing dot makes a hostname fully qualified — `www.sec.gov.` and `www.sec.gov` reach the same server, but only
 * the latter is in an allowlist, and the WHATWG parser preserves the dot. Stripped before the lookup so the FQDN form
 * is admitted rather than rejected as an unknown host.
 */
export function canonicalHostname(url: URL): string {
	return url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname
}
