/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The six-role frontmatter contract for the docs-reorg site (docs-architecture cleanup, Phase 0,
 *   task 2 — `docs/superpowers/plans/2026-08-03-docs-reorg.md`). Every published page declares which
 *   of six roles it plays, and each role carries required fields on top of `role:` itself:
 *
 *   - `tutorial`, `guide` — `verified-with:` (the version a page's captured command output ran
 *     against).
 *   - `reference` — `source-of-truth:`.
 *   - `landing` — `audience:`.
 *   - `explanation`, `evidence` — no fields beyond `role:`.
 *
 *   `validatePage` is pure — no filesystem, no process, no sidebar — so it's unit-tested directly in
 *   `check-docs-structure.test.ts`. The gate (`check-docs-structure.ts`) wires it against the real
 *   corpus under `--strict`; without the flag the gate keeps enforcing the OLD seven-role vocabulary
 *   (guide/tutorial/concept/reference/decision/evidence/landing) this module deliberately does not
 *   know about — that vocabulary is retired by this contract, not extended by it.
 */

/**
 * The six-role page vocabulary the docs-reorg site is built around.
 */
export const PAGE_ROLES = ["tutorial", "guide", "reference", "explanation", "landing", "evidence"] as const

/**
 * One of the six page roles.
 */
export type PageRole = (typeof PAGE_ROLES)[number]

/**
 * Roles that must carry `verified-with:` — a task/guide's captured command output is only as good as the version it was
 * run against.
 */
const VERIFIED_WITH_ROLES = new Set<PageRole>(["tutorial", "guide"])

function isRoleValue(value: unknown): value is PageRole {
	return typeof value === "string" && (PAGE_ROLES as readonly string[]).includes(value)
}

/**
 * A field counts as declared when it has a non-empty scalar value, or is present as a non-scalar value the caller has
 * already normalized to `true` (see `check-docs-structure.ts`'s `toFrontmatterRecord`). `undefined`, `null`, and `""`
 * all count as not-declared.
 */
function isDeclared(frontmatter: Record<string, unknown>, key: string): boolean {
	const value = frontmatter[key]

	return value !== undefined && value !== null && value !== ""
}

/**
 * Validate one page's frontmatter against the six-role contract.
 *
 * Returns human-readable failure strings prefixed with `path`, or `[]` when the page is valid. A missing or
 * unrecognized `role:` short-circuits — the role-conditional field rules below don't apply until the role itself is
 * known-good, so each of those cases returns a single failure rather than compounding with the field-level checks.
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
