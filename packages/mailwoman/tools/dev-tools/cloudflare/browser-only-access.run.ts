/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Creates or updates the zone's custom firewall rule that keeps a bucket path browser-only.
 *
 *   Usage: node --env-file=.env packages/mailwoman/tools/dev-tools/cloudflare/browser-only-access.run.ts --zone
 *   <zone name> --host <hostname> --path-prefix <prefix> --origins <origin,origin> [--apply]
 *
 *   Without `--apply` it only reads: it prints the zone's current rule and the rule it would write. The rule is found
 *   by its description, so a rerun replaces it in place.
 */

import { APIClient } from "@mailwoman/core/api"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { $private } from "#env"
import {
	browserOnlyAccessDescription,
	browserOnlyAccessExpression,
} from "#tools/dev-tools/cloudflare/browser-only-access"

const { values } = parseArguments({
	options: {
		zone: { type: "string" },
		host: { type: "string" },
		"path-prefix": { type: "string" },
		origins: { type: "string" },
		apply: { type: "boolean" },
	},
})

if (!values.zone || !values.host || !values["path-prefix"] || !values.origins) {
	throw new Error("--zone, --host, --path-prefix and --origins are required")
}

const token = $private.CLOUDFLARE_API_TOKEN

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set")

const access = {
	host: values.host,
	pathPrefix: values["path-prefix"],
	origins: values.origins
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean),
}

const rule = {
	description: browserOnlyAccessDescription(access),
	expression: browserOnlyAccessExpression(access),
	action: "block",
	enabled: true,
}

/**
 * The envelope every Cloudflare v4 response arrives in.
 */
interface Envelope<T> {
	success: boolean
	errors: Array<{ code: number; message: string }>
	result: T
}

interface Ruleset {
	id: string
	rules?: Array<{ id: string; description?: string; expression: string; action: string }>
}

await using client = new APIClient({
	displayName: "cloudflare-api",
	axios: { baseURL: "https://api.cloudflare.com/client/v4", headers: { Authorization: `Bearer ${token}` } },
})

/**
 * A failed Cloudflare call, reported by method, path, status and Cloudflare's own message.
 *
 * It keeps no `cause`, because the client's error holds the request config and with it the bearer token.
 */
class CloudflareCallError extends Error {
	readonly status: number | null

	constructor(method: string, url: string, status: number | null, detail: string) {
		super(`${method} ${url}: ${status ?? "no response"}${detail ? ` ${detail}` : ""}`)
		this.status = status
	}
}

const call = async <T>(method: string, url: string, data?: unknown): Promise<T> => {
	const response = await client.fetch<Envelope<T>>({ method, url, data }).catch((error: unknown) => {
		const failure = error as { status?: number; cause?: { response?: { data?: Partial<Envelope<unknown>> } } }
		const errors = failure.cause?.response?.data?.errors ?? []

		throw new CloudflareCallError(
			method,
			url,
			failure.status ?? null,
			errors.map((e) => `${e.code} ${e.message}`).join("; ")
		)
	})

	if (!response.data.success) {
		throw new Error(`${method} ${url}: ${response.data.errors.map((e) => `${e.code} ${e.message}`).join("; ")}`)
	}

	return response.data.result
}

const [zone] = await call<Array<{ id: string; name: string }>>("GET", `/zones?name=${encodeURIComponent(values.zone)}`)

if (!zone) throw new Error(`no zone named ${values.zone} is visible to this token`)

const entrypoint = `/zones/${zone.id}/rulesets/phases/http_request_firewall_custom/entrypoint`

/**
 * The status Cloudflare answers for a phase entrypoint the zone has never written.
 */
const NO_ENTRYPOINT_STATUS = 404

/**
 * The zone's custom-rules ruleset, or null when the zone has none yet.
 */
const ruleset = await call<Ruleset>("GET", entrypoint).catch((error: { status?: number }) => {
	if (error.status === NO_ENTRYPOINT_STATUS) return null

	throw error
})

const existing = ruleset?.rules?.find((candidate) => candidate.description === rule.description) ?? null

console.log(`zone ${zone.name} (${zone.id})`)
console.log(`current: ${existing ? `${existing.action} when ${existing.expression}` : "no rule with this description"}`)
console.log(`wanted:  ${rule.action} when ${rule.expression}`)

if (!values.apply) {
	console.log("dry run; pass --apply to write the rule")
} else if (!ruleset) {
	await call("PUT", entrypoint, { rules: [rule] })

	console.log("created the zone's custom-rules ruleset with this rule")
} else if (existing) {
	await call("PATCH", `/zones/${zone.id}/rulesets/${ruleset.id}/rules/${existing.id}`, rule)

	console.log(`updated rule ${existing.id}`)
} else {
	await call("POST", `/zones/${zone.id}/rulesets/${ruleset.id}/rules`, rule)

	console.log(`added the rule to ruleset ${ruleset.id}`)
}
