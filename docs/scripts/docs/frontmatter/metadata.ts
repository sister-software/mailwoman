/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Frontmatter validation for the six published-page roles. Guides and tutorials require
 * `verified-with`, references require `source-of-truth`, and landing pages require `audience`.
 * Explanations and evidence pages require only `role`. The legacy seven-role policy is enforced by
 * the structural check, not by this module.
 */

/**
 * Roles accepted by the published documentation.
 */
export const PAGE_ROLES = ["tutorial", "guide", "reference", "explanation", "landing", "evidence"] as const

/**
 * A supported published-page role.
 */
export type PageRole = (typeof PAGE_ROLES)[number]

/**
 * Roles whose captured command output must name the version used.
 */
const VERIFIED_WITH_ROLES = new Set<PageRole>(["tutorial", "guide"])

function isRoleValue(value: unknown): value is PageRole {
	return typeof value === "string" && (PAGE_ROLES as readonly string[]).includes(value)
}

/**
 * Return whether a frontmatter field has a non-empty value.
 */
function isDeclared(frontmatter: Record<string, unknown>, key: string): boolean {
	const value = frontmatter[key]

	return value !== undefined && value !== null && value !== ""
}

/**
 * Validate one page and return path-prefixed errors, or an empty array when valid.
 */
export function validatePage(frontmatter: Record<string, unknown>, path: string): string[] {
	if (!isDeclared(frontmatter, "role")) {
		return [`${path}: missing required \`role:\` frontmatter — every published page must declare one`]
	}

	const role = frontmatter.role

	if (!isRoleValue(role)) {
		return [`${path}: role \`${String(role)}\` is not in the page-role vocabulary (${PAGE_ROLES.join(", ")})`]
	}

	const failures: string[] = []

	if (VERIFIED_WITH_ROLES.has(role) && !isDeclared(frontmatter, "verified-with")) {
		failures.push(`${path}: role \`${role}\` requires \`verified-with:\` frontmatter`)
	}

	if (role === "reference" && !isDeclared(frontmatter, "source-of-truth")) {
		failures.push(`${path}: role \`reference\` requires \`source-of-truth:\` frontmatter`)
	}

	if (role === "landing" && !isDeclared(frontmatter, "audience")) {
		failures.push(`${path}: role \`landing\` requires \`audience:\` frontmatter`)
	}

	return failures
}
