/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared plumbing for the docs structural checks (docs-architecture cleanup, Phase 4): walk
 *   `docs/articles`, parse each page's frontmatter block, and derive the Docusaurus doc id. Used by
 *   `check-docs-structure.ts` (the CI gate) and `list-stale-docs.ts` (the quarterly freshness
 *   sweep).
 *
 *   The frontmatter parser is deliberately minimal — top-level `key: scalar` lines only, quotes
 *   stripped. Nested values (`tags:` arrays, block scalars) record the key as declared but carry no
 *   value. That covers every field the checks read (`role`, `status`, `title`, `id`, `review-by`,
 *   …) without pulling a YAML dependency into what must stay a no-install fast path in CI.
 */

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the docs-plugin content root (`docs/articles`). */
export const ARTICLES_DIR = path.resolve(SCRIPT_DIR, "..", "articles")

/** One `.md`/`.mdx` page under `docs/articles`. */
export interface DocPage {
	/** Path relative to `docs/articles`, POSIX separators — e.g. `concepts/bio-labels.mdx`. */
	relativePath: string
	/** Absolute filesystem path. */
	absolutePath: string
	/**
	 * The Docusaurus doc id: the directory part of the file path plus the frontmatter `id:` override (which replaces only
	 * the final segment) or the extension-less basename — e.g. `recipes/timezones.md` with `id: timezone-lookup` →
	 * `recipes/timezone-lookup`.
	 */
	id: string
	/** Top-level scalar frontmatter fields, quotes stripped. */
	frontmatter: Map<string, string>
	/** Every top-level frontmatter key, including keys whose values are nested/non-scalar. */
	declaredKeys: Set<string>
}

const FRONTMATTER_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/

/** Strip one layer of matched surrounding quotes from a scalar value. */
function unquote(value: string): string {
	if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
		return value.slice(1, -1)
	}

	return value
}

/**
 * Parse the leading `---`-fenced frontmatter block of a markdown source. Returns top-level scalar fields plus the set
 * of all declared top-level keys.
 */
export function parseFrontmatter(source: string): { fields: Map<string, string>; declaredKeys: Set<string> } {
	const fields = new Map<string, string>()
	const declaredKeys = new Set<string>()
	const lines = source.split("\n")

	if (lines[0]?.trim() !== "---") return { fields, declaredKeys }

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!

		if (line.trim() === "---") break

		const match = FRONTMATTER_KEY_PATTERN.exec(line)

		if (!match) continue // Nested/continuation line (indented, `- ` item, …) — not a top-level key.

		const [, key, rawValue] = match
		declaredKeys.add(key!)

		const value = unquote(rawValue!.trim())

		if (value) {
			fields.set(key!, value)
		}
	}

	return { fields, declaredKeys }
}

/** Walk `docs/articles` and parse every `.md`/`.mdx` page. */
export async function collectDocPages(): Promise<DocPage[]> {
	const entries = await readdir(ARTICLES_DIR, { recursive: true })
	const pages: DocPage[] = []

	for (const entry of entries.sort()) {
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
 * Mirrors the docs plugin's `exclude` globs in `docs/docusaurus.config.ts` (search for `exclude:` under `path:
 * "articles"`) — pages the build never publishes, so they can't collide or orphan on the live site. Keep the two in
 * sync when the config's exclusions change.
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
 * The evals and retrospectives trees are a delegated workstream (see the coordination boundary in
 * `docs/superpowers/plans/2026-07-14-documentation-architecture-cleanup.md`); their role/status adoption ships with its
 * own gate. Only the duplicate-title check reads them — a title collision is site-wide by nature.
 */
export function isDelegatedWorkstream(page: DocPage): boolean {
	return page.relativePath.startsWith("evals/") || page.relativePath.startsWith("retrospectives/")
}
