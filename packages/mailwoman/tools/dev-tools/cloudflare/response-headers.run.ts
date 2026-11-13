// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Creates or updates a zone's response-header rule that marks one host's
 *   responses `Cross-Origin-Resource-Policy: cross-origin`.
 *
 *   A cross-origin isolated page, such as Earth's, refuses a cross-origin subresource
 *   that WebKit loads without CORS unless the response sends that header.
 *   WebKit loads `@font-face` files that way, so a public font host needs it.
 *
 *   Usage: node --env-file=.env packages/mailwoman/tools/dev-tools/cloudflare/response-headers.run.ts
 *   --zone <zone name> --host <hostname> [--apply]
 *
 *   Without `--apply` it only reads: it prints the zone's response-header rules
 *   and the rule it would write.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { $private } from "#env"
import { upsertZoneRule } from "#tools/dev-tools/cloudflare/rulesets"

const { values } = parseArguments({
	options: {
		zone: { type: "string" },
		host: { type: "string" },
		apply: { type: "boolean" },
	},
})

if (!values.zone || !values.host) throw new Error("--zone and --host are required")

const token = $private.CLOUDFLARE_API_TOKEN

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set")

await upsertZoneRule({
	token,
	zoneName: values.zone,
	phase: "http_response_headers_transform",
	rule: {
		description: `mailwoman: cross-origin resource policy for ${values.host}`,
		expression: `(http.host eq "${values.host}")`,
		action: "rewrite",
		enabled: true,
		action_parameters: {
			headers: { "Cross-Origin-Resource-Policy": { operation: "set", value: "cross-origin" } },
		},
	},
	apply: Boolean(values.apply),
	log: (line) => console.log(line),
})
