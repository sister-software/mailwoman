/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Cloudflare custom rule that keeps a bucket path readable by the demo's browser and refuses a plain download.
 *
 *   A browser's range reader sends a `Range` header, an `Origin` of the page that runs it, and the `Sec-Fetch-Mode`
 *   and `Sec-Fetch-Site` headers it sets itself. A command-line client sends none of the last three by default, so the
 *   rule refuses a lazy `wget` or `curl`. A client that sets all four headers still reads the file.
 */

/**
 * What one browser-only access rule covers.
 */
export interface BrowserOnlyAccess {
	/**
	 * The bucket's hostname, such as `public.mailwoman.post`.
	 */
	host: string
	/**
	 * The path prefix the rule covers, such as `/mailwoman/gazetteer/`.
	 */
	pathPrefix: string
	/**
	 * The page origins whose browsers may read the path, such as `https://mailwoman.post`.
	 */
	origins: readonly string[]
}

/**
 * The description that identifies the rule, so a rerun updates it rather than adding a second.
 */
export function browserOnlyAccessDescription(access: BrowserOnlyAccess): string {
	return `mailwoman: browser-only range access to ${access.host}${access.pathPrefix}`
}

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/**
 * The rule's expression: it matches a request on the path that lacks any of the browser's headers.
 *
 * A matching request is blocked.
 */
export function browserOnlyAccessExpression(access: BrowserOnlyAccess): string {
	if (!access.origins.length) throw new Error("a browser-only access rule needs at least one origin")

	const origins = access.origins.map(quote).join(" ")

	return [
		`(http.host eq ${quote(access.host)}`,
		`and starts_with(http.request.uri.path, ${quote(access.pathPrefix)})`,
		"and (",
		`not any(http.request.headers.names[*] eq "range")`,
		`or not any(http.request.headers["origin"][*] in {${origins}})`,
		`or not any(http.request.headers["sec-fetch-mode"][*] eq "cors")`,
		`or not any(http.request.headers["sec-fetch-site"][*] in {"same-site" "same-origin"})`,
		"))",
	].join(" ")
}
