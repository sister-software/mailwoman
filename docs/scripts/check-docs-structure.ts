/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Docs structural gate (docs-architecture cleanup, Phase 4; frontmatter contract rewrite, docs-reorg
 *   Phase 0 task 2). Static frontmatter parse only — no install, no Docusaurus build — so it runs in
 *   seconds as the first step of the Docs workflow (`.github/workflows/docs-build.yml`) and locally
 *   via `yarn workspace @mailwoman/docs lint:structure` (or `node docs/scripts/check-docs-structure.ts`
 *   from the repo root).
 *
 *   Three checks:
 *
 *   1. Frontmatter validity — two modes, chosen by the `--strict` CLI flag:
 *        - Strict (`--strict`) — THE LIVE MODE. Both CI (`.github/workflows/docs-build.yml`) and
 *          `yarn workspace @mailwoman/docs lint:structure` pass the flag as of the docs-reorg
 *          Task 5 skeleton cutover. It enforces the six-role contract
 *          (`docs-frontmatter-contract.ts`): `role:` is required on EVERY published page, value ∈
 *          {tutorial, guide, reference, explanation, landing, evidence}, with role-conditional
 *          required fields (`validatePage`).
 *        - Legacy (default, no flag): the seven-role vocabulary the contract replaced
 *          (guide/tutorial/concept/reference/decision/evidence/landing), required only on a
 *          manifest of entry pages and every recipe (`ROLE_REQUIRED_PAGES` /
 *          `ROLE_REQUIRED_DIRECTORIES`). Nothing invokes it now. It is kept because the pages it
 *          describes still exist unpublished under `docs/records/site-2026-08/`, so pointing the
 *          script at that tree remains a way to check them; delete it once nothing does.
 *   2. Exact duplicate `title:` frontmatter across the published site.
 *   3. Orphan pages — published docs absent from every sidebar in `docs/sidebars.ts`.
 *
 *   Checks 2 and 3 are unconditional — the `--strict` flag affects check 1 only. Known-intentional
 *   findings live in `docs-structure-allowlist.ts`, each with a reason. The evals/retrospectives
 *   trees are a delegated workstream and are skipped by the frontmatter check (both modes) and by
 *   the legacy `role:` requirement (see `isDelegatedWorkstream`).
 */

import { parseArgs } from "node:util"

import sidebars from "../sidebars.ts"
import { validatePage } from "./docs-frontmatter-contract.ts"
import { collectDocPages, type DocPage, isDelegatedWorkstream, isExcludedFromBuild } from "./docs-frontmatter.ts"
import { allowedDuplicateTitles, allowedOrphans } from "./docs-structure-allowlist.ts"

// parseArgs reads process.argv.slice(2) by default — the blessed pattern (core/scripting/utils'
// `cliArguments()` docstring): call it bare rather than slicing process.argv ourselves.
const { values: flags } = parseArgs({
	options: {
		strict: { type: "boolean", default: false },
	},
})

const strict = flags.strict

//#region Policy vocabulary

/**
 * The page-role vocabulary and each role's required frontmatter fields — the content-model table from the cleanup plan,
 * reproduced on the policy page (`docs/articles/contributing-docs.mdx`). `landing` is the site-specific addition for
 * pure navigation surfaces. `reference` and `decision` carry conditional requirements handled below (`generated-from`
 * or `owner`; `superseded-by` once closed).
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
 * The `status:` vocabulary the record-class chrome renders (`src/theme/DocItem/Content`).
 */
const STATUS_VOCABULARY = new Set(["active-decision", "superseded"])

/**
 * Pages that MUST declare `role:` (relative to `docs/articles`): the front door, the entry pages, the four canonical
 * concept pages, the docs policy itself — plus every recipe, matched by directory below.
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

//#endregion

//#region Check 1 — frontmatter validity

/**
 * Legacy frontmatter check — the original policy, unchanged. Used when `--strict` is absent so CI keeps passing against
 * the current tree until a later task deletes it and flips the flag.
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
 * Flattens a `DocPage`'s parsed frontmatter into the plain `Record<string, unknown>` shape `validatePage` expects.
 * Declared keys with a scalar value carry that value; a declared key whose value is nested/non-scalar (an array, a
 * block scalar — `docs-frontmatter.ts`'s parser records the key but not the value) carries `true`, which is enough for
 * a presence check but nothing a role rule here reads for content.
 */
function toFrontmatterRecord(page: DocPage): Record<string, unknown> {
	const record: Record<string, unknown> = {}

	for (const key of page.declaredKeys) {
		record[key] = page.frontmatter.get(key) ?? true
	}

	return record
}

/**
 * Strict frontmatter check — the NEW six-role contract, enforced on every published page (minus the delegated
 * evals/retrospectives workstream, same boundary as the legacy check). This is what a later task points CI at once the
 * old tree is gone; run today it fails wholesale against the current corpus, which predates the contract — that's
 * expected, not a regression.
 */
function checkFrontmatterStrict(pages: DocPage[]): string[] {
	const failures: string[] = []

	for (const page of pages) {
		if (isDelegatedWorkstream(page)) continue

		failures.push(...validatePage(toFrontmatterRecord(page), page.relativePath))
	}

	return failures
}

//#endregion

//#region Check 2 — duplicate titles

function checkDuplicateTitles(pages: DocPage[]): string[] {
	const failures: string[] = []
	const allowedTitles = new Set(allowedDuplicateTitles.map((allowance) => allowance.title))
	const byTitle = new Map<string, string[]>()

	for (const page of pages) {
		const title = page.frontmatter.get("title")

		if (!title) continue // Half the corpus titles from its first H1 — only declared titles can collide exactly.

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

//#endregion

//#region Check 3 — orphan pages

/**
 * Recursively gather explicit doc ids and autogenerated directory roots from a sidebar item.
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
		// Autogenerated sidebars pull in every doc under their directory by file location.
		const coveredByDirectory = [...autogeneratedDirs].some((dir) => page.relativePath.startsWith(`${dir}/`))

		if (coveredByDirectory || ids.has(page.id) || allowedIDs.has(page.id)) continue

		failures.push(`${page.relativePath}: reachable at /docs/ but absent from every sidebar (id \`${page.id}\`)`)
	}

	return failures
}

//#endregion

const pages = await collectDocPages()
const published = pages.filter((page) => !isExcludedFromBuild(page))

const failuresByCheck: [name: string, failures: string[]][] = [
	[
		strict ? "Frontmatter validity (--strict: six-role contract)" : "Frontmatter validity (legacy vocabulary)",
		strict ? checkFrontmatterStrict(published) : checkFrontmatterLegacy(published),
	],
	["Duplicate titles", checkDuplicateTitles(published)],
	["Orphan pages", checkOrphans(published)],
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
			`Contract: docs/scripts/docs-frontmatter-contract.ts · voice + section rules: ` +
			`docs/engineering/writing-system.md · allowlist: docs/scripts/docs-structure-allowlist.ts`
	)

	process.exit(1)
}

console.log(
	`\nDocs structure OK — ${published.length} published pages checked (${pages.length} total under articles/).`
)
