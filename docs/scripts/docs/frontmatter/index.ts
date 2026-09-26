/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared plumbing for the docs structural checks: walk `docs/articles`, parse each page's frontmatter block, and derive the Docusaurus doc id.
 *
 *   The frontmatter parser is deliberately minimal — top-level `key: scalar` lines only, quotes stripped, with nested values recording the key but no value — so no YAML dependency reaches the pre-install CI path.
 */

// This file is reached by `check-docs-structure.ts`, which the Docs workflow runs
// before `yarn install`, so only Node builtins may resolve.
/* oxlint-disable typescript/no-restricted-imports -- runs before `yarn install`; see above */
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
/* oxlint-enable typescript/no-restricted-imports */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The docs package root, taken as this module's path before its `scripts/` segment so it holds at any depth.
 */
const DOCS_ROOT = SCRIPT_DIR.slice(0, SCRIPT_DIR.lastIndexOf(`${path.sep}scripts${path.sep}`))

/**
 * Absolute path to the docs-plugin content root `docs/articles`.
 */
export const ARTICLES_DIR = path.join(DOCS_ROOT, "articles")

/**
 * One `.md`/`.mdx` page under `docs/articles`.
 */
export interface DocPage {
	/**
	 * Path relative to `docs/articles` with posix separators.
	 */
	relativePath: string
	absolutePath: string
	/**
	 * The Docusaurus doc id: the file path's directory plus the frontmatter `id:`
	 * override for the final segment, or the extension-less basename.
	 */
	id: string
	frontmatter: Map<string, string>
	/**
	 * Every top-level frontmatter key, including nested/non-scalar ones that `frontmatter` omits.
	 */
	declaredKeys: Set<string>
}

const FRONTMATTER_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/

function unquote(value: string): string {
	if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
		return value.slice(1, -1)
	}

	return value
}

/**
 * Parse the leading `---`-fenced frontmatter block of a markdown source.
 */
export function parseFrontmatter(source: string): { fields: Map<string, string>; declaredKeys: Set<string> } {
	const fields = new Map<string, string>()
	const declaredKeys = new Set<string>()

	let opened = false

	/* oxlint-disable-next-line mailwoman/prefer-spliterator -- pre-install, built-ins-only CI over a handful of frontmatter lines */
	for (const line of source.split("\n")) {
		if (!opened) {
			if (line.trim() !== "---") break

			opened = true

			continue
		}

		if (line.trim() === "---") break

		const match = FRONTMATTER_KEY_PATTERN.exec(line)

		if (!match) continue

		const [, key, rawValue] = match
		declaredKeys.add(key!)

		const value = unquote(rawValue!.trim())

		if (value) {
			fields.set(key!, value)
		}
	}

	return { fields, declaredKeys }
}

/**
 * Walk `docs/articles` and parse every `.md`/`.mdx` page.
 */
export async function collectDocPages(): Promise<DocPage[]> {
	const entries = await readdir(ARTICLES_DIR, { recursive: true })
	const pages: DocPage[] = []

	for (const entry of entries.toSorted()) {
		const relativePath = entry.split(path.sep).join("/")

		if (!relativePath.endsWith(".md") && !relativePath.endsWith(".mdx")) continue

		const absolutePath = path.join(ARTICLES_DIR, entry)
		const { fields, declaredKeys } = parseFrontmatter(await readFile(absolutePath, "utf8"))

		const directory = path.posix.dirname(relativePath)
		const basename = path.posix.basename(relativePath).replace(/\.mdx?$/, "")
		const idTail = fields.get("id") ?? basename
		const id = directory === "." ? idTail : `${directory}/${idTail}`

		pages.push({ relativePath, absolutePath, id, frontmatter: fields, declaredKeys })
	}

	return pages
}

/**
 * Mirrors the docs plugin's `exclude` globs in `docs/docusaurus.config.ts`,
 * and must stay in sync with them.
 */
export function isExcludedFromBuild(page: DocPage): boolean {
	if (page.relativePath.startsWith("reviews/")) return true

	if (page.relativePath.startsWith("evals/")) {
		const basename = path.posix.basename(page.relativePath)

		return basename.includes("postmortem") || basename.includes("night-shift-session-report")
	}

	return false
}

/**
 * The evals and retrospectives trees are a delegated workstream that only the duplicate-title check reads.
 */
export function isDelegatedWorkstream(page: DocPage): boolean {
	return page.relativePath.startsWith("evals/") || page.relativePath.startsWith("retrospectives/")
}
