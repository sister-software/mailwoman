// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_http_get` fetches one URL with the GET method and returns the status, the content type,
 * the requested headers, and the body up to a byte cap or a projection of a JSON body.
 *
 * The request goes through `httpGet` in `#check-kit/http-get`, which `mwops probe` also uses.
 * That module states the address policy: loopback and public addresses are admitted, and a host that
 * resolves to a private, link-local, unique-local, multicast or unspecified address is refused.
 */

import { z } from "zod"

import { DEFAULT_MAX_BYTES, httpGet, type HTTPGetServices, MAX_MAX_BYTES } from "#check-kit/http-get"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"

/**
 * The tool's input.
 */
const HTTP_GET_INPUT_SCHEMA = z.object({
	url: z.string().min(1).describe("An http or https URL."),
	accept: z.string().min(1).optional().describe("The `Accept` header. Default `*/*`."),
	json_path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"A dotted path through the objects of a JSON body, such as `conformsTo` or `meta.count`. Arrays are not traversed. " +
				"An absent path, or a body that isn't JSON, is reported as an error rather than as null."
		),
	max_bytes: z
		.number()
		.int()
		.positive()
		.max(MAX_MAX_BYTES)
		.default(DEFAULT_MAX_BYTES)
		.describe(`The most body bytes read. Default ${DEFAULT_MAX_BYTES}, at most ${MAX_MAX_BYTES}.`),
	include_headers: z.array(z.string().min(1)).optional().describe("Response header names to return."),
})

/**
 * The `mwdev_http_get` tool.
 *
 * @param services The host resolver, injected by a test.
 */
export const httpGetTool = (_deps: DevToolDeps, services: HTTPGetServices = {}): DevTool => ({
	name: "mwdev_http_get",
	description:
		"GET one http or https URL and return the status, the final URL and redirect chain, the content type, the requested " +
		"headers, and the body up to `max_bytes` with `truncated` and the full length when known, or the value at " +
		"`json_path` in a JSON body. A binary type returns its length without the body. It sends no body, cookie or " +
		"credential. A host that resolves to a private, link-local or unique-local address is refused, and loopback is " +
		"admitted. A request that reached no response returns `error` with its cause code, such as ECONNREFUSED.",
	inputSchema: HTTP_GET_INPUT_SCHEMA,
	handler: async (args) => {
		const input = HTTP_GET_INPUT_SCHEMA.parse(args)

		return httpGet(
			{
				url: input.url,
				accept: input.accept,
				jsonPath: input.json_path,
				maxBytes: input.max_bytes,
				includeHeaders: input.include_headers,
			},
			services
		)
	},
})
