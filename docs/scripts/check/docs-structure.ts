/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Check documentation frontmatter, duplicate titles, sidebar coverage, relative links, and cited
 *   repository paths. The script uses static parsing and runs before installation in CI. Use
 *   `--strict` for the current six-role frontmatter rules; without it, the legacy rules apply.
 *   Checks for duplicate titles, orphan pages, links, and path citations run in either mode.
 *   Intentional findings are listed in `docs-structure-allowlist.ts`.
 */

// CI runs this script before installation, so its imports must use Node builtins or relative paths.
// oxlint-disable-next-line typescript/no-restricted-imports -- runs before `yarn install`; see above
import { parseArgs } from "node:util"

import sidebars from "../../sidebars.ts"
import { collectDocPages, type DocPage, isDelegatedWorkstream, isExcludedFromBuild } from "../docs/frontmatter/index.ts"
import { validatePage } from "../docs/frontmatter/metadata.ts"
import { collectMarkdownFiles, findBrokenLinks } from "../docs/links.ts"
import { censusPathCitations } from "../docs/path-citations.ts"
import { allowedDuplicateTitles, allowedOrphans } from "../docs/structure-allowlist.ts"

const { values: flags } = parseArgs({
	options: {
		strict: { type: "boolean", default: false },
	},
})

const strict = flags.strict

// #region Frontmatter policy

/**
 * Required frontmatter fields for each legacy page role.
 */
const ROLE_REQUIRED_FIELDS: Record<string, string[]> = {
	guide: ["audience", "prerequisites", "verified-with"],
	tutorial: ["audience", "prerequisites", "verified-with"],
	concept: ["audience", "source-of-truth", "review-by"],
	reference: ["source-of-truth"],
	decision: ["status", "owner"],
	evidence: ["date", "status", "promoted-conclusions"],
	landing: ["audience"],
}

/**
 * Status values supported by the documentation theme.
 */
const STATUS_VOCABULARY = new Set(["active-decision", "superseded"])

/**
 * Entry pages that require `role:` in legacy mode.
 */
const ROLE_REQUIRED_PAGES = [
	"index.mdx",
	"getting-started.mdx",
	"documentation-map.mdx",
	"contributing-docs.mdx",
	"concepts/how-mailwoman-parses-an-address.mdx",
	"concepts/how-mailwoman-resolves-a-place.mdx",
	"concepts/data-locales-and-coverage.mdx",
	"concepts/quality-and-evaluation.mdx",
]

const ROLE_REQUIRED_DIRECTORIES = ["recipes/"]

// #endregion

// #region Check 1 — frontmatter validity

/**
 * Validate pages against the legacy role rules.
 */
function checkFrontmatterLegacy(pages: DocPage[]): string[] {
	const failures: string[] = []
	const checkable = pages.filter((page) => !isDelegatedWorkstream(page))
	const byRelativePath = new Map(checkable.map((page) => [page.relativePath, page]))

	for (const requiredPath of ROLE_REQUIRED_PAGES) {
		const page = byRelativePath.get(requiredPath)

		if (!page) {
			failures.push(`${requiredPath}: page is on the role manifest but missing from docs/articles`)
		} else if (!page.declaredKeys.has("role")) {
			failures.push(`${requiredPath}: missing required \`role:\` frontmatter (manifest page)`)
		}
	}

	for (const page of checkable) {
		const inRequiredDirectory = ROLE_REQUIRED_DIRECTORIES.some((dir) => page.relativePath.startsWith(dir))

		if (inRequiredDirectory && !page.declaredKeys.has("role")) {
			failures.push(`${page.relativePath}: missing required \`role:\` frontmatter (all recipes declare one)`)
		}

		if (page.declaredKeys.has("role")) {
			const role = page.frontmatter.get("role") ?? ""
			const requiredFields = ROLE_REQUIRED_FIELDS[role]

			if (!requiredFields) {
				failures.push(
					`${page.relativePath}: role \`${role}\` is not in the policy vocabulary (${Object.keys(ROLE_REQUIRED_FIELDS).join(", ")})`
				)
			} else {
				for (const field of requiredFields) {
					if (!page.declaredKeys.has(field)) {
						failures.push(`${page.relativePath}: role \`${role}\` requires \`${field}:\` frontmatter`)
					}
				}

				if (role === "reference" && !page.declaredKeys.has("generated-from") && !page.declaredKeys.has("owner")) {
					failures.push(`${page.relativePath}: role \`reference\` requires \`generated-from:\` or \`owner:\``)
				}
			}
		}

		if (page.declaredKeys.has("status")) {
			const status = page.frontmatter.get("status") ?? ""

			if (!STATUS_VOCABULARY.has(status)) {
				failures.push(
					`${page.relativePath}: status \`${status}\` is not in the chrome vocabulary (${[...STATUS_VOCABULARY].join(", ")})`
				)
			}

			if (status === "superseded" && !page.declaredKeys.has("superseded-by")) {
				failures.push(`${page.relativePath}: status \`superseded\` requires a \`superseded-by:\` link`)
			}
		}
	}

	return failures
}

/**
 * Convert parsed frontmatter to the shape expected by `validatePage`.
 */
function toFrontmatterRecord(page: DocPage): Record<string, unknown> {
	const record: Record<string, unknown> = {}

	for (const key of page.declaredKeys) {
		record[key] = page.frontmatter.get(key) ?? true
	}

	return record
}

/**
 * Validate published pages against the six-role interface, excluding delegated workstreams.
 */
function checkFrontmatterStrict(pages: DocPage[]): string[] {
	const failures: string[] = []

	for (const page of pages) {
		if (isDelegatedWorkstream(page)) continue

		failures.push(...validatePage(toFrontmatterRecord(page), page.relativePath))
	}

	return failures
}

// #endregion

// #region Check 2 — duplicate titles

function checkDuplicateTitles(pages: DocPage[]): string[] {
	const failures: string[] = []
	const allowedTitles = new Set(allowedDuplicateTitles.map((allowance) => allowance.title))
	const byTitle = new Map<string, string[]>()

	for (const page of pages) {
		const title = page.frontmatter.get("title")

		if (!title) continue // Only explicit frontmatter titles are checked for duplicates.

		const paths = byTitle.get(title) ?? []
		paths.push(page.relativePath)
		byTitle.set(title, paths)
	}

	for (const [title, paths] of byTitle) {
		if (paths.length < 2 || allowedTitles.has(title)) continue

		failures.push(`duplicate title \`${title}\`: ${paths.join(", ")}`)
	}

	return failures
}

// #endregion

// #region Check 3 — orphan pages

/**
 * Collect document ids and autogenerated directory roots from a sidebar item.
 */
function walkSidebarItem(item: unknown, ids: Set<string>, autogeneratedDirs: Set<string>): void {
	if (typeof item === "string") {
		ids.add(item)

		return
	}

	if (typeof item !== "object" || item === null) return

	const record = item as Record<string, unknown>

	if (record.type === "autogenerated" && typeof record.dirName === "string") {
		autogeneratedDirs.add(record.dirName)
	}

	if ((record.type === "doc" || record.type === "ref") && typeof record.id === "string") {
		ids.add(record.id)
	}

	if (record.type === "category") {
		if (Array.isArray(record.items)) {
			for (const child of record.items) {
				walkSidebarItem(child, ids, autogeneratedDirs)
			}
		}

		walkSidebarItem(record.link, ids, autogeneratedDirs)
	}
}

function checkOrphans(pages: DocPage[]): string[] {
	const failures: string[] = []
	const allowedIDs = new Set(allowedOrphans.map((allowance) => allowance.id))
	const ids = new Set<string>()
	const autogeneratedDirs = new Set<string>()

	for (const sidebar of Object.values(sidebars)) {
		for (const item of sidebar as unknown[]) {
			walkSidebarItem(item, ids, autogeneratedDirs)
		}
	}

	for (const page of pages) {
		// Autogenerated entries include every document beneath their directory.
		const coveredByDirectory = [...autogeneratedDirs].some((dir) => page.relativePath.startsWith(`${dir}/`))

		if (coveredByDirectory || ids.has(page.id) || allowedIDs.has(page.id)) continue

		failures.push(`${page.relativePath}: reachable at /docs/ but absent from every sidebar (id \`${page.id}\`)`)
	}

	return failures
}

// #endregion

// #region Check 4 — relative links resolve

/**
 * Check relative links throughout the docs tree, including unpublished pages.
 */
async function checkRelativeLinks(): Promise<string[]> {
	const broken = await findBrokenLinks(await collectMarkdownFiles())

	return broken.map(({ file, line, target }) => `${file}:${line}: relative link \`${target}\` resolves to nothing`)
}

// #endregion

// #region Check 5 — backticked repository paths resolve

/**
 * Check repository paths cited in current documents; historical records are excluded.
 */
async function checkPathCitations(): Promise<string[]> {
	const { broken } = await censusPathCitations(await collectMarkdownFiles())

	return broken.map(({ file, line, target }) => `${file}:${line}: \`${target}\` names no file in the repository`)
}

// #endregion

const pages = await collectDocPages()
const published = pages.filter((page) => !isExcludedFromBuild(page))

const failuresByCheck: [name: string, failures: string[]][] = [
	[
		strict ? "Frontmatter validity (--strict: six-role interface)" : "Frontmatter validity (legacy vocabulary)",
		strict ? checkFrontmatterStrict(published) : checkFrontmatterLegacy(published),
	],
	["Duplicate titles", checkDuplicateTitles(published)],
	["Orphan pages", checkOrphans(published)],
	["Relative links", await checkRelativeLinks()],
	["Path citations", await checkPathCitations()],
]

let failureCount = 0

for (const [name, failures] of failuresByCheck) {
	if (!failures.length) {
		console.log(`✓ ${name}`)

		continue
	}

	failureCount += failures.length

	console.error(`✗ ${name} (${failures.length}):`)

	for (const failure of failures) {
		console.error(`  - ${failure}`)
	}
}

// Guard the allowlists against rot: an allowance whose subject no longer exists should be removed.
const publishedIDs = new Set(published.map((page) => page.id))
const publishedTitles = new Set(published.map((page) => page.frontmatter.get("title")))

for (const allowance of allowedOrphans) {
	if (!publishedIDs.has(allowance.id)) {
		failureCount += 1

		console.error(`✗ stale allowlist entry: orphan \`${allowance.id}\` no longer exists — remove it`)
	}
}

for (const allowance of allowedDuplicateTitles) {
	if (!publishedTitles.has(allowance.title)) {
		failureCount += 1

		console.error(`✗ stale allowlist entry: duplicate title \`${allowance.title}\` no longer exists — remove it`)
	}
}

if (failureCount > 0) {
	console.error(
		`\nDocs structure check FAILED (${failureCount} finding${failureCount === 1 ? "" : "s"}). ` +
			`Metadata: docs/scripts/docs/frontmatter/metadata.ts · voice + section rules: ` +
			`docs/engineering/writing-system.md · allowlist: docs/scripts/docs/structure-allowlist.ts`
	)

	process.exit(1)
}

console.log(
	`\nDocs structure OK — ${published.length} published pages checked (${pages.length} total under articles/).`
)
