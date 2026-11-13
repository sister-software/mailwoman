// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes one rule into a Cloudflare zone's ruleset for a phase, such as `http_request_firewall_custom`.
 *
 *   The rule is found by its description, so a rerun replaces it in place.
 *   Without `apply` the call only reads and prints what it would write.
 */

import { APIClient } from "@mailwoman/core/api"

/**
 * One rule as the rulesets API takes it.
 *
 * `action_parameters` holds a transform rule's header edits.
 */
export interface ZoneRule {
	description: string
	expression: string
	action: string
	enabled: boolean
	action_parameters?: Record<string, unknown>
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

/**
 * The status Cloudflare answers for a phase entrypoint the zone has never written.
 */
const NO_ENTRYPOINT_STATUS = 404

/**
 * Prints the zone's rules for `phase` and the rule it would write, and writes it when `apply` is set.
 */
export async function upsertZoneRule(options: {
	token: string
	zoneName: string
	phase: string
	rule: ZoneRule
	apply: boolean
	log: (line: string) => void
}): Promise<void> {
	const { rule, log } = options

	await using client = new APIClient({
		displayName: "cloudflare-api",
		axios: {
			baseURL: "https://api.cloudflare.com/client/v4",
			headers: { Authorization: `Bearer ${options.token}` },
		},
	})

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

	const [zone] = await call<Array<{ id: string; name: string }>>(
		"GET",
		`/zones?name=${encodeURIComponent(options.zoneName)}`
	)

	if (!zone) throw new Error(`no zone named ${options.zoneName} is visible to this token`)

	const entrypoint = `/zones/${zone.id}/rulesets/phases/${options.phase}/entrypoint`

	const ruleset = await call<Ruleset>("GET", entrypoint).catch((error: { status?: number }) => {
		if (error.status === NO_ENTRYPOINT_STATUS) return null

		throw error
	})

	const existing = ruleset?.rules?.find((candidate) => candidate.description === rule.description) ?? null

	log(`zone ${zone.name} (${zone.id}): ${ruleset?.rules?.length ?? 0} rules in ${options.phase}`)

	for (const other of ruleset?.rules ?? []) {
		log(`  ${other.action}: ${other.description ?? "(no description)"}\n    when ${other.expression}`)
	}

	log(`current: ${existing ? `${existing.action} when ${existing.expression}` : "no rule with this description"}`)
	log(`wanted:  ${rule.action} when ${rule.expression}`)

	if (!options.apply) {
		log("dry run; pass --apply to write the rule")
	} else if (!ruleset) {
		await call("PUT", entrypoint, { rules: [rule] })

		log(`created the zone's ${options.phase} ruleset with this rule`)
	} else if (existing) {
		await call("PATCH", `/zones/${zone.id}/rulesets/${ruleset.id}/rules/${existing.id}`, rule)

		log(`updated rule ${existing.id}`)
	} else {
		await call("POST", `/zones/${zone.id}/rulesets/${ruleset.id}/rules`, rule)

		log(`added the rule to ruleset ${ruleset.id}`)
	}
}
