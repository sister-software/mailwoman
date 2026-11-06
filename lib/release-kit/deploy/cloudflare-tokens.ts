// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Lists the scoped Cloudflare API tokens this repository uses. Each role holds the permissions one consumer
 *   needs and the environment key the consumer reads. The deploy role serves `wrangler deploy` and
 *   `wrangler r2 object put`. The cache-purge role serves a purge of a stale object on `public.mailwoman.post`.
 *
 *   Cloudflare lets a token create tokens when it holds "Account API Tokens: Edit". The minter role is that
 *   token. The operator creates it once from a dashboard link that pre-fills the permission, and
 *   `mwops release mint-cloudflare-tokens` then creates every other role through the API. The Global API Key
 *   authenticates the same calls without the dashboard step.
 */

import type { CloudflarePermission } from "@mailwoman/core/cloudflare"

/**
 * The zone every role with a zone permission is scoped to.
 *
 * A zone ID is a public identifier, safe to commit.
 * The zone belongs to the account `CLOUDFLARE_ACCOUNT_ID` identifies.
 */
export const MAILWOMAN_ZONE = { name: "mailwoman.post", id: "9566b3cee0c16ea6c9a0819f925e8581" } as const

/**
 * The token roles this repository mints or creates by hand.
 */
export const CloudflareTokenRoleID = {
	Minter: "minter",
	Deploy: "deploy",
	CachePurge: "cache-purge",
} as const

export type CloudflareTokenRoleID = (typeof CloudflareTokenRoleID)[keyof typeof CloudflareTokenRoleID]

export interface CloudflareTokenRole {
	id: CloudflareTokenRoleID
	/**
	 * The token's name on Cloudflare.
	 *
	 * The mint operation finds an earlier token of the role by this name.
	 */
	name: string
	/**
	 * The environment key the token's consumer reads.
	 */
	env: string
	purpose: string
	permissions: readonly CloudflarePermission[]
	/**
	 * Whether the mint operation creates this role.
	 *
	 * The minter is created from its dashboard link, because creating it needs the permission it grants.
	 */
	minted: boolean
}

/**
 * Every role, in the order the report lists them.
 *
 * The deploy permissions start from Cloudflare's "Edit Cloudflare Workers" template.
 * Its KV, Tail, User Details and Memberships groups are dropped because no Worker here binds KV,
 * and D1 and Zone Read are added for the license ledger and the custom domains.
 */
export const CLOUDFLARE_TOKEN_ROLES: readonly CloudflareTokenRole[] = [
	{
		id: CloudflareTokenRoleID.Minter,
		name: "mailwoman token minter",
		env: "CLOUDFLARE_TOKEN_MINTER",
		purpose: "Creates the other tokens. Holds no other permission.",
		permissions: [{ group: "Account API Tokens Write", key: "account_api_tokens", type: "edit", scope: "account" }],
		minted: false,
	},
	{
		id: CloudflareTokenRoleID.Deploy,
		name: "mailwoman deploy",
		env: "CLOUDFLARE_API_TOKEN",
		purpose: "wrangler deploy for the five Workers, D1 migrations, and wrangler r2 object put.",
		permissions: [
			{ group: "Workers Scripts Write", key: "workers_scripts", type: "edit", scope: "account" },
			{ group: "Workers R2 Storage Write", key: "workers_r2", type: "edit", scope: "account" },
			{ group: "D1 Write", key: "d1", type: "edit", scope: "account" },
			{ group: "Account Settings Read", key: "account_settings", type: "read", scope: "account" },
			{ group: "Workers Routes Write", key: "workers_routes", type: "edit", scope: "zone" },
			{ group: "Zone Read", key: "zone", type: "read", scope: "zone" },
		],
		minted: true,
	},
	{
		id: CloudflareTokenRoleID.CachePurge,
		name: "mailwoman cache purge",
		env: "CLOUDFLARE_CACHE_PURGE_TOKEN",
		purpose: `Purges cached URLs on ${MAILWOMAN_ZONE.name}.`,
		permissions: [{ group: "Cache Purge", key: "cache", type: "purge", scope: "zone" }],
		minted: true,
	},
]

export function findCloudflareTokenRole(id: string): CloudflareTokenRole {
	const role = CLOUDFLARE_TOKEN_ROLES.find((candidate) => candidate.id === id)

	if (!role) {
		throw new Error(
			`no Cloudflare token role "${id}"; the roles are ${CLOUDFLARE_TOKEN_ROLES.map((r) => r.id).join(", ")}`
		)
	}

	return role
}
