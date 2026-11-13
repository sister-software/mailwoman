// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Cloudflare custom rule that keeps the public bucket's databases readable by the
 *   demo's browser and the `mailwoman data` CLI, and refuses a plain download.
 *
 *   A browser's range reader sends a `Range` header, an `Origin` of the page that runs it,
 *   and the `Sec-Fetch-Mode` and `Sec-Fetch-Site` headers it sets itself.
 *   The CLI sends its client header.
 *
 *   A command-line download sends neither by default, so the rule refuses a lazy `wget` or `curl`.
 *   A client that sets the same headers still reads the file.
 */

/**
 * What one access rule covers.
 */
export interface BucketAccess {
	/**
	 * The bucket's hostname, such as `public.mailwoman.post`.
	 */
	host: string
	/**
	 * The path prefixes the rule covers, such as `/mailwoman/gazetteer/`.
	 */
	pathPrefixes: readonly string[]
	/**
	 * The page origins whose browsers may read the paths, such as `https://mailwoman.post`.
	 */
	origins: readonly string[]
	/**
	 * The header a non-browser client the rule admits sends, such as `X-Mailwoman-Client`.
	 */
	clientHeader: string
	/**
	 * Origins of local previews whose browsers may read the paths, such as `http://localhost:7771`.
	 *
	 * A page on `localhost` is cross-site to the bucket, so these origins are
	 * admitted with any `Sec-Fetch-Site` value.
	 * The bucket's CORS rule must admit the same origins.
	 */
	localOrigins?: readonly string[]
}

/**
 * The description that identifies the rule, so a rerun updates it rather than adding a second.
 */
export function bucketAccessDescription(access: BucketAccess): string {
	return `mailwoman: browser and CLI access to ${access.host} databases`
}

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/**
 * The rule's expression: it matches a request on a covered path that sends neither
 * the browser's headers nor the client header.
 *
 * A matching request is blocked.
 * Cloudflare lower-cases header names, so the client header is matched lower-cased.
 */
export function bucketAccessExpression(access: BucketAccess): string {
	if (!access.origins.length) throw new Error("a bucket access rule needs at least one origin")

	if (!access.pathPrefixes.length) throw new Error("a bucket access rule needs at least one path prefix")

	const origins = access.origins.map(quote).join(" ")

	const paths = access.pathPrefixes.map((prefix) => `starts_with(http.request.uri.path, ${quote(prefix)})`).join(" or ")

	const siteOrigin = [
		`any(http.request.headers["origin"][*] in {${origins}})`,
		`any(http.request.headers["sec-fetch-site"][*] in {"same-site" "same-origin"})`,
	].join(" and ")

	const localOrigins = access.localOrigins?.length
		? ` or any(http.request.headers["origin"][*] in {${access.localOrigins.map(quote).join(" ")}})`
		: ""

	const browser = [
		`any(http.request.headers.names[*] eq "range")`,
		`any(http.request.headers["sec-fetch-mode"][*] eq "cors")`,
		`((${siteOrigin})${localOrigins})`,
	].join(" and ")

	const client = `any(http.request.headers.names[*] eq ${quote(access.clientHeader.toLowerCase())})`

	return `(http.host eq ${quote(access.host)} and (${paths}) and not ((${browser}) or ${client}))`
}
