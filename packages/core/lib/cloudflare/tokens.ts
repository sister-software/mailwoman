/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds Cloudflare API token requests and the dashboard links that create the same tokens by hand.
 *   A permission is declared once with both spellings Cloudflare uses for it: the permission group name the
 *   API lists, and the short key a dashboard template link takes.
 */

import { stringifyJSON } from "#json"

const DASHBOARD = "https://dash.cloudflare.com/"

/**
 * One permission as the API names it and as a dashboard template link keys it.
 */
export interface CloudflarePermission {
	/**
	 * The permission group's name in `GET /accounts/:id/tokens/permission_groups`.
	 *
	 * The API spells write access "Write" and the dashboard spells it "Edit".
	 * {@linkcode resolvePermissionGroups} matches either.
	 */
	group: string
	/**
	 * The `permissionGroupKeys` entry of a dashboard template link.
	 */
	key: string
	type: "read" | "edit" | "purge"
	scope: "account" | "zone"
}

/**
 * A permission group as `GET /accounts/:id/tokens/permission_groups` returns it.
 */
export interface PermissionGroup {
	id: string
	name: string
}

export interface TokenPolicy {
	effect: "allow"
	resources: Record<string, string>
	permission_groups: PermissionGroup[]
}

export interface TokenRequest {
	name: string
	policies: TokenPolicy[]
}

/**
 * A dashboard link that opens the account-owned token form with `permissions` and `name` filled in.
 *
 * The form asks which account when the viewer belongs to several.
 * A template link cannot preset a zone, so a token with a zone permission asks the viewer to pick the zone.
 */
export function tokenTemplateLink(name: string, permissions: readonly CloudflarePermission[]): string {
	const keys = permissions.map((permission) => ({ key: permission.key, type: permission.type }))
	const query = new URLSearchParams({ permissionGroupKeys: stringifyJSON(keys), name })

	// The dashboard reads `to` unencoded, as Cloudflare's own template links write it.
	return `${DASHBOARD}?to=/:account/api-tokens&${query.toString().replaceAll("+", "%20")}`
}

function groupNameKey(name: string): string {
	return name.replace(/ (Write|Edit)$/u, " write").toLowerCase()
}

/**
 * The permission group of each of `permissions`, matched by name.
 *
 * Throws naming every permission without a group, so a renamed group stops a mint before any token exists.
 */
export function resolvePermissionGroups(
	permissions: readonly CloudflarePermission[],
	groups: readonly PermissionGroup[]
): Map<CloudflarePermission, PermissionGroup> {
	const byName = new Map(groups.map((group) => [groupNameKey(group.name), group]))
	const resolved = new Map<CloudflarePermission, PermissionGroup>()
	const missing: string[] = []

	for (const permission of permissions) {
		const group = byName.get(groupNameKey(permission.group))

		if (group) {
			resolved.set(permission, group)
		} else {
			missing.push(permission.group)
		}
	}

	if (missing.length) {
		throw new Error(`Cloudflare lists no permission group named ${missing.map((name) => `"${name}"`).join(", ")}`)
	}

	return resolved
}

/**
 * The request body that creates a token holding `permissions`.
 *
 * Account permissions apply to `accountID` and zone permissions to `zoneID`, one policy each.
 * A token with no permission of a scope gets no policy for it.
 */
export function tokenRequestBody(options: {
	name: string
	permissions: readonly CloudflarePermission[]
	groups: Map<CloudflarePermission, PermissionGroup>
	accountID: string
	zoneID?: string
}): TokenRequest {
	const { name, permissions, groups, accountID, zoneID } = options

	if (!zoneID && permissions.some((permission) => permission.scope === "zone")) {
		throw new Error(`token "${name}" holds a zone permission and no zone was given`)
	}

	const resources = {
		account: { [`com.cloudflare.api.account.${accountID}`]: "*" },
		zone: { [`com.cloudflare.api.account.zone.${zoneID}`]: "*" },
	}

	const policies = (["account", "zone"] as const)
		.map((scope) => ({
			effect: "allow" as const,
			resources: resources[scope],
			permission_groups: permissions
				.filter((permission) => permission.scope === scope)
				.map((permission) => {
					const group = groups.get(permission)

					if (!group) throw new Error(`no permission group resolved for "${permission.group}"`)

					return { id: group.id, name: group.name }
				}),
		}))
		.filter((policy) => policy.permission_groups.length)

	return { name, policies }
}
