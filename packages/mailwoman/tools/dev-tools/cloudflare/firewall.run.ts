// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Creates or updates the zone's custom firewall rule that keeps the public bucket's
 *   databases readable by the demo's browser and the `mailwoman data` CLI.
 *
 *   Usage: node --env-file=.env packages/mailwoman/tools/dev-tools/cloudflare/firewall.run.ts --zone
 *   <zone name> --host <hostname> --path-prefixes <prefix,prefix> --origins <origin,origin>
 *   [--local-origins <origin,origin>] [--apply]
 *
 *   Without `--apply` it only reads: it prints every custom rule the zone has and the rule it would write.
 *   The rule is found by its description, so a rerun replaces it in place.
 */

import { isPresent } from "@mailwoman/core/objects"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { DATA_CLIENT_HEADER } from "#data/remote"
import { $private } from "#env"
import { bucketAccessDescription, bucketAccessExpression } from "#tools/dev-tools/cloudflare/firewall"
import { upsertZoneRule } from "#tools/dev-tools/cloudflare/rulesets"

const { values } = parseArguments({
	options: {
		zone: { type: "string" },
		host: { type: "string" },
		"path-prefixes": { type: "string" },
		origins: { type: "string" },
		"local-origins": { type: "string" },
		apply: { type: "boolean" },
	},
})

if (!values.zone || !values.host || !values["path-prefixes"] || !values.origins) {
	throw new Error("--zone, --host, --path-prefixes and --origins are required")
}

const list = (value: string) =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter(isPresent)

const token = $private.CLOUDFLARE_FIREWALL_TOKEN

if (!token) {
	throw new Error(
		"CLOUDFLARE_FIREWALL_TOKEN is not set; `mwops release mint-cloudflare-tokens` mints the firewall role's"
	)
}

const access = {
	host: values.host,
	pathPrefixes: list(values["path-prefixes"]),
	origins: list(values.origins),
	clientHeader: DATA_CLIENT_HEADER,
	localOrigins: values["local-origins"] ? list(values["local-origins"]) : [],
}

await upsertZoneRule({
	token,
	zoneName: values.zone,
	phase: "http_request_firewall_custom",
	rule: {
		description: bucketAccessDescription(access),
		expression: bucketAccessExpression(access),
		action: "block",
		enabled: true,
	},
	apply: Boolean(values.apply),
	log: (line) => console.log(line),
})
