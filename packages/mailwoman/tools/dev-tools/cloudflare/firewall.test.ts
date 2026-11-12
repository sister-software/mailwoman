// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The bucket access rule's expression scopes to one host and its database prefixes,
 *   and admits a request carrying every browser header or the CLI's client header.
 */

import { describe, expect, it } from "vitest"

import { bucketAccessDescription, bucketAccessExpression } from "#tools/dev-tools/cloudflare/firewall"

const access = {
	host: "public.mailwoman.post",
	pathPrefixes: ["/mailwoman/gazetteer/", "/mailwoman/addresses/"],
	origins: ["https://mailwoman.post", "https://earth.mailwoman.post"],
	clientHeader: "X-Mailwoman-Client",
}

describe("bucketAccessExpression", () => {
	it("blocks a covered request that carries neither the browser's headers nor the client header", () => {
		expect(bucketAccessExpression(access)).toBe(
			'(http.host eq "public.mailwoman.post" and (' +
				'starts_with(http.request.uri.path, "/mailwoman/gazetteer/") or ' +
				'starts_with(http.request.uri.path, "/mailwoman/addresses/")) and not ((' +
				'any(http.request.headers.names[*] eq "range") and ' +
				'any(http.request.headers["origin"][*] in {"https://mailwoman.post" "https://earth.mailwoman.post"}) and ' +
				'any(http.request.headers["sec-fetch-mode"][*] eq "cors") and ' +
				'any(http.request.headers["sec-fetch-site"][*] in {"same-site" "same-origin"})) or ' +
				'any(http.request.headers.names[*] eq "x-mailwoman-client")))'
		)
	})

	it("refuses a rule with no origin or no prefix", () => {
		expect(() => bucketAccessExpression({ ...access, origins: [] })).toThrow("at least one origin")
		expect(() => bucketAccessExpression({ ...access, pathPrefixes: [] })).toThrow("at least one path prefix")
	})

	it("names the rule by its host", () => {
		expect(bucketAccessDescription(access)).toBe("mailwoman: browser and CLI access to public.mailwoman.post databases")
	})
})
