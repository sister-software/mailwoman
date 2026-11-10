/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser-only access rule's expression scopes to one host and prefix and requires every browser header.
 */

import { describe, expect, it } from "vitest"

import {
	browserOnlyAccessDescription,
	browserOnlyAccessExpression,
} from "#tools/dev-tools/cloudflare/browser-only-access"

const access = {
	host: "public.mailwoman.post",
	pathPrefix: "/mailwoman/gazetteer/",
	origins: ["https://mailwoman.post", "https://earth.mailwoman.post"],
}

describe("browserOnlyAccessExpression", () => {
	it("blocks a request on the host and prefix that lacks a Range, an allowed Origin or the fetch headers", () => {
		expect(browserOnlyAccessExpression(access)).toBe(
			'(http.host eq "public.mailwoman.post" and starts_with(http.request.uri.path, "/mailwoman/gazetteer/") and ( ' +
				'not any(http.request.headers.names[*] eq "range") ' +
				'or not any(http.request.headers["origin"][*] in {"https://mailwoman.post" "https://earth.mailwoman.post"}) ' +
				'or not any(http.request.headers["sec-fetch-mode"][*] eq "cors") ' +
				'or not any(http.request.headers["sec-fetch-site"][*] in {"same-site" "same-origin"}) ))'
		)
	})

	it("refuses a rule with no origin, which would block every reader", () => {
		expect(() => browserOnlyAccessExpression({ ...access, origins: [] })).toThrow("at least one origin")
	})

	it("names the rule by its host and prefix", () => {
		expect(browserOnlyAccessDescription(access)).toBe(
			"mailwoman: browser-only range access to public.mailwoman.post/mailwoman/gazetteer/"
		)
	})
})
