// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The native API's OpenAPI document metadata. It reads this package's `package.json` when the module loads, so it
 *   lives apart from the app factory: a Cloudflare Worker bundle has no package files, and imports `#app` without
 *   this module.
 */

import { type OpenAPIDocInfo, readServedDocumentInfo } from "@mailwoman/api-kit"

import { FormattingTag, GeocodingTag, MetaTag, ParsingTag, ResolvingTag } from "#operations/tags"

/**
 * OpenAPI metadata shared by the mounted endpoint and document generator.
 */
export const MAILWOMAN_API_DOC_INFO: OpenAPIDocInfo = {
	...(await readServedDocumentInfo(import.meta.url, "@mailwoman/api")),
	license: { name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" },
	contact: { name: "Sister Software", url: "https://mailwoman.post" },
	servers: [
		{
			url: "http://{host}:{port}",
			variables: { host: { default: "127.0.0.1" }, port: { default: "3000" } },
		},
	],
	security: [],
	tags: [ParsingTag, GeocodingTag, ResolvingTag, FormattingTag, MetaTag],
}
