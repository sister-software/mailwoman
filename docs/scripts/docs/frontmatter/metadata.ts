/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Validates the frontmatter fields that each published-page role requires.
 */

/**
 * The page roles that published documentation accepts.
 */
export const PAGE_ROLES = ["tutorial", "guide", "reference", "explanation", "landing", "evidence"] as const

/**
 * One of the published-page roles in `PAGE_ROLES`.
 */
export type PageRole = (typeof PAGE_ROLES)[number]

/**
 * These roles must declare `verified-with`, the version their captured command output came from.
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
 * Validate one page's frontmatter and return its errors, each prefixed with the page path.
 *
 * Tutorials and guides require `verified-with`.
 * References require `source-of-truth`, and landing pages require `audience`.
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
