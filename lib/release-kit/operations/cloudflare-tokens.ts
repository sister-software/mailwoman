/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Cloudflare token operations: report each role's token, mint the scoped tokens into a new file, and purge
 *   cached URLs with the cache-purge token. The roles live in `#release-kit/deploy/cloudflare-tokens`.
 */

import {
	type PermissionGroup,
	resolvePermissionGroups,
	tokenRequestBody,
	tokenTemplateLink,
} from "@mailwoman/core/cloudflare"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { writePrivateTextFile } from "@mailwoman/core/fs/writers"
import Cloudflare from "cloudflare"
import { resolvePath } from "path-ts"
import { z } from "zod"

import {
	CLOUDFLARE_TOKEN_ROLES,
	type CloudflareTokenRole,
	CloudflareTokenRoleID,
	findCloudflareTokenRole,
	MAILWOMAN_ZONE,
} from "#release-kit/deploy/cloudflare-tokens"
import { $private, $public } from "#release-kit/env"
import { defineOperation, OperationEffect } from "#release-kit/operation"
import { flag, list } from "#release-kit/operations/inputs"

function accountID(): string {
	const id = $public.CLOUDFLARE_ACCOUNT_ID

	if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID is unset")

	return id
}

function roleToken(role: CloudflareTokenRole): string | undefined {
	switch (role.id) {
		case CloudflareTokenRoleID.Minter:
			return $private.CLOUDFLARE_TOKEN_MINTER
		case CloudflareTokenRoleID.Deploy:
			return $private.CLOUDFLARE_API_TOKEN
		case CloudflareTokenRoleID.CachePurge:
			return $private.CLOUDFLARE_CACHE_PURGE_TOKEN
	}
}

function roleLink(role: CloudflareTokenRole): string {
	return tokenTemplateLink(role.name, role.permissions)
}

/**
 * How a request authenticates: an API token, or the Global API Key with its login email.
 */
type CloudflareCredential = { kind: "token"; token: string } | { kind: "global-key"; email: string; key: string }

/**
 * A client holding exactly `credential`.
 *
 * The SDK otherwise reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`
 * and `CLOUDFLARE_EMAIL` from the environment.
 * A mint would then send the deploy token beside the minter or the Global API Key.
 */
function cloudflareClient(credential: CloudflareCredential): Cloudflare {
	return credential.kind === "token"
		? new Cloudflare({ apiToken: credential.token, apiKey: null, apiEmail: null })
		: new Cloudflare({ apiToken: null, apiKey: credential.key, apiEmail: credential.email })
}

interface TokenVerification {
	id: string
	status: string
	expiresOn: string | null
}

/**
 * Verify one token, trying the account-owned endpoint before the user-owned one.
 */
async function verify(
	token: string
): Promise<{ owner: "account" | "user"; verification: TokenVerification } | { owner: null; error: string }> {
	const client = cloudflareClient({ kind: "token", token })

	const read = (result: { id: string; status: string; expires_on?: string }): TokenVerification => ({
		id: result.id,
		status: result.status,
		expiresOn: result.expires_on ?? null,
	})

	try {
		return { owner: "account", verification: read(await client.accounts.tokens.verify({ account_id: accountID() })) }
	} catch {
		try {
			return { owner: "user", verification: read(await client.user.tokens.verify()) }
		} catch (error) {
			return { owner: null, error: error instanceof Error ? error.message : String(error) }
		}
	}
}

const roleReport = z.object({
	role: z.string(),
	env: z.string(),
	purpose: z.string(),
	state: z.enum(["unset", "active", "refused"]),
	owner: z.enum(["account", "user"]).nullable(),
	id: z.string().nullable(),
	expiresOn: z.string().nullable(),
	detail: z.string().nullable(),
	link: z.string(),
})

/**
 * `release.cloudflare-tokens`: each role's token as Cloudflare verifies it,
 * and the dashboard link that creates it.
 */
export const cloudflareTokens = defineOperation({
	id: "release.cloudflare-tokens",
	description:
		"Verify each Cloudflare token role's token from the environment and print the dashboard link that creates it. Start with the minter link, then run mint-cloudflare-tokens.",
	effect: OperationEffect.Read,
	options: {},
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({ roles: z.array(roleReport) }),
	async run() {
		const roles = await Promise.all(
			CLOUDFLARE_TOKEN_ROLES.map(async (role) => {
				const token = roleToken(role)
				const base = { role: role.id, env: role.env, purpose: role.purpose, link: roleLink(role) }
				const absent = { owner: null, id: null, expiresOn: null }

				if (!token) return { ...base, ...absent, state: "unset" as const, detail: null }

				const result = await verify(token)

				if (!result.owner) return { ...base, ...absent, state: "refused" as const, detail: result.error }

				const active = result.verification.status === "active"

				return {
					...base,
					state: active ? ("active" as const) : ("refused" as const),
					owner: result.owner,
					id: result.verification.id,
					expiresOn: result.verification.expiresOn,
					detail: active ? null : `status ${result.verification.status}`,
				}
			})
		)

		return { roles }
	},
	formatOutput({ roles }) {
		return roles
			.map((role) =>
				[
					`${role.role} (${role.env}): ${role.state}${role.owner ? `, ${role.owner}-owned` : ""}${role.id ? `, id ${role.id}` : ""}${role.expiresOn ? `, expires ${role.expiresOn}` : ""}`,
					`  ${role.purpose}`,
					...(role.detail ? [`  ${role.detail}`] : []),
					`  create: ${role.link}`,
				].join("\n")
			)
			.join("\n\n")
	},
})

function mintCredential(): CloudflareCredential {
	const minter = $private.CLOUDFLARE_TOKEN_MINTER

	if (minter) return { kind: "token", token: minter }

	const email = $private.CLOUDFLARE_EMAIL
	const key = $private.CLOUDFLARE_API_KEY

	if (email && key) return { kind: "global-key", email, key }

	throw new Error(
		[
			"mint-cloudflare-tokens needs CLOUDFLARE_TOKEN_MINTER, or CLOUDFLARE_EMAIL with CLOUDFLARE_API_KEY.",
			`Create the minter from: ${roleLink(findCloudflareTokenRole("minter"))}`,
		].join("\n")
	)
}

const mintedToken = z.object({
	role: z.string(),
	env: z.string(),
	id: z.string().nullable(),
	replaced: z.array(z.string()),
})

/**
 * `release.mint-cloudflare-tokens`: create each role's account-owned token
 * and write the tokens to a new file.
 */
export const mintCloudflareTokens = defineOperation({
	id: "release.mint-cloudflare-tokens",
	description:
		"Create the scoped Cloudflare tokens (--roles deploy,cache-purge; default both) as account-owned tokens and write them as KEY=value lines to a new file, --out/-o, readable only by its owner. Authenticates with CLOUDFLARE_TOKEN_MINTER or the Global API Key. --replace deletes an earlier token of the same name after the file is written.",
	effect: OperationEffect.ExternalWrite,
	options: { out: { type: "string", short: "o" }, roles: { type: "string" }, replace: { type: "boolean" } },
	inputSchema: z.object({ out: z.string({ error: "--out <file> is required" }), roles: list, replace: flag }).strict(),
	outputSchema: z.object({ out: z.string(), minted: z.array(mintedToken) }),
	async run(input, context) {
		const roles: CloudflareTokenRole[] = input.roles.length
			? input.roles.map(findCloudflareTokenRole)
			: CLOUDFLARE_TOKEN_ROLES.filter((role) => role.minted)

		const unmintable = roles.filter((role) => !role.minted)

		if (unmintable.length) {
			throw new Error(`${unmintable.map((role) => role.id).join(", ")} is created from its dashboard link, not minted`)
		}

		const out = resolvePath(input.out)

		if (await tryStat(out)) throw new Error(`${out} exists; name a new file`)

		const account = accountID()
		const client = cloudflareClient(mintCredential())

		// Every request body is built before the first token exists, so a renamed permission group stops the run whole.
		const groups: PermissionGroup[] = []

		for await (const group of client.accounts.tokens.permissionGroups.list({ account_id: account })) {
			if (group.id && group.name) {
				groups.push({ id: group.id, name: group.name })
			}
		}

		const bodies = roles.map((role) => ({
			role,
			body: tokenRequestBody({
				name: role.name,
				permissions: role.permissions,
				groups: resolvePermissionGroups(role.permissions, groups),
				accountID: account,
				zoneID: MAILWOMAN_ZONE.id,
			}),
		}))

		const existing: Array<{ id?: string; name?: string }> = []

		for await (const token of client.accounts.tokens.list({ account_id: account })) {
			existing.push(token)
		}

		const earlier = new Map(
			roles.map((role) => [
				role,
				existing.filter((token) => token.name === role.name).flatMap((token) => (token.id ? [token.id] : [])),
			])
		)

		const blocked = roles.filter((role) => earlier.get(role)!.length && !input.replace)

		if (blocked.length) {
			throw new Error(
				`account tokens already exist for ${blocked.map((role) => `${role.id} (${earlier.get(role)!.join(", ")})`).join("; ")}; pass --replace to delete them after the new tokens are written`
			)
		}

		const replaced = (role: CloudflareTokenRole): string[] => (input.replace ? earlier.get(role)! : [])

		if (context.dryRun) {
			for (const { role, body } of bodies) {
				context.log(`would create "${body.name}" as ${role.env}:`)

				for (const policy of body.policies) {
					context.log(
						`  ${Object.keys(policy.resources).join(", ")}: ${policy.permission_groups.map((group) => group.name).join(", ")}`
					)
				}
			}

			return {
				out: out.toString(),
				minted: roles.map((role) => ({ role: role.id, env: role.env, id: null, replaced: replaced(role) })),
			}
		}

		const created = []

		for (const { role, body } of bodies) {
			const token = await client.accounts.tokens.create({ account_id: account, ...body })

			if (!token.id || !token.value) throw new Error(`Cloudflare created "${body.name}" without returning its value`)

			context.log(`created "${body.name}" (${token.id}) as ${role.env}`)
			created.push({ role, token: { id: token.id, value: token.value } })
		}

		await writePrivateTextFile(created.map(({ role, token }) => `${role.env}=${token.value}\n`).join(""), out)

		for (const { role } of created) {
			for (const id of replaced(role)) {
				await client.accounts.tokens.delete(id, { account_id: account })
				context.log(`deleted the earlier "${role.name}" token ${id}`)
			}
		}

		return {
			out: out.toString(),
			minted: created.map(({ role, token }) => ({
				role: role.id,
				env: role.env,
				id: token.id,
				replaced: replaced(role),
			})),
		}
	},
	formatOutput({ out, minted }) {
		const lines = minted.map(
			(token) =>
				`${token.role}: ${token.env}${token.id ? ` = token ${token.id}` : " (dry run)"}${token.replaced.length ? `, replacing ${token.replaced.join(", ")}` : ""}`
		)

		return [`wrote ${out} (mode 0600)`, ...lines].join("\n")
	},
})

/**
 * `release.purge-cloudflare-cache`: drop cached copies of URLs on the mailwoman.post zone.
 */
export const purgeCloudflareCache = defineOperation({
	id: "release.purge-cloudflare-cache",
	description: `Purge cached copies of --urls a,b on ${MAILWOMAN_ZONE.name} with CLOUDFLARE_CACHE_PURGE_TOKEN.`,
	effect: OperationEffect.ExternalWrite,
	options: { urls: { type: "string" } },
	inputSchema: z.object({ urls: list }).strict(),
	outputSchema: z.object({ purged: z.array(z.string()) }),
	async run(input, context) {
		if (!input.urls.length) throw new Error("purge-cloudflare-cache needs --urls")

		const outside = input.urls.filter((url) => {
			const host = new URL(url).hostname

			return host !== MAILWOMAN_ZONE.name && !host.endsWith(`.${MAILWOMAN_ZONE.name}`)
		})

		if (outside.length) throw new Error(`outside ${MAILWOMAN_ZONE.name}: ${outside.join(", ")}`)

		if (context.dryRun) {
			context.log(`would purge ${input.urls.length} URL(s)`)

			return { purged: [] }
		}

		const token = $private.CLOUDFLARE_CACHE_PURGE_TOKEN

		if (!token) {
			throw new Error(
				"CLOUDFLARE_CACHE_PURGE_TOKEN is unset; mint it with `yarn mwops release mint-cloudflare-tokens --roles cache-purge -o <file>`"
			)
		}

		const client = cloudflareClient({ kind: "token", token })

		// A non-Enterprise plan accepts at most 30 URLs in one purge request.
		for (let start = 0; start < input.urls.length; start += 30) {
			await client.cache.purge({ zone_id: MAILWOMAN_ZONE.id, files: input.urls.slice(start, start + 30) })
		}

		return { purged: input.urls }
	},
})
