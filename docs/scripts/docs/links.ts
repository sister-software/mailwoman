/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Finds relative markdown links under `docs/` whose targets do not exist on disk.
 *
 *   Only `./` and `../` targets are checked. A bare `docs/x.md` could be a repo path or a Docusaurus doc id, and an
 *   absolute `/docs/…` link is a route. The `#anchor` is dropped before resolution, and a target directory passes
 *   because Docusaurus serves its index page.
 */

// The Docs workflow runs `check/docs-structure.ts`, which imports this file, before `yarn install`.
// Only Node builtins can resolve at that point.
/* oxlint-disable typescript/no-restricted-imports -- runs before `yarn install`; see above */
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
/* oxlint-enable typescript/no-restricted-imports */

import { pathExists } from "./exists.ts"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The docs package root.
 *
 * It is the part of this file's path before the last `scripts/` segment,
 * so it stays correct if this file moves to another depth.
 */
const DOCS_ROOT = SCRIPT_DIR.slice(0, SCRIPT_DIR.lastIndexOf(`${path.sep}scripts${path.sep}`))

/**
 * These directories under `docs/` hold generated or installed files and are skipped.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", "build", ".docusaurus", "static", "i18n"])

/**
 * This pattern matches an inline link whose target starts with `./` or `../`.
 *
 * Group 1 is the target, and group 2 is the optional `#anchor`.
 *
 * Reference-style definitions (`[id]: ../x.md`) are ignored.
 */
const RELATIVE_LINK = /\]\((\.\.?\/[^)#\s]+)(#[^)\s]*)?\)/g

/**
 * A relative link whose target does not exist.
 */
export interface BrokenLink {
	/**
	 * The file that contains the link, relative to the repository root.
	 */
	file: string
	/**
	 * The target as written, without its anchor.
	 */
	target: string
	/**
	 * The 1-based line where the link starts.
	 */
	line: number
}

/**
 * Return the absolute paths of every authored `.md` and `.mdx` file under `root`, sorted.
 */
export async function collectMarkdownFiles(root: string = DOCS_ROOT): Promise<string[]> {
	const found: string[] = []
	const pending = [root]

	while (pending.length) {
		const directory = pending.pop()!

		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					pending.push(path.join(directory, entry.name))
				}

				continue
			}

			if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
				found.push(path.join(directory, entry.name))
			}
		}
	}

	return found.toSorted()
}

/**
 * Return the relative links in `files` whose targets do not exist, with file paths relative to `repoRoot`.
 */
export async function findBrokenLinks(
	files: string[],
	repoRoot: string = path.dirname(DOCS_ROOT)
): Promise<BrokenLink[]> {
	const broken: BrokenLink[] = []

	for (const file of files) {
		const text = await readFile(file, "utf8")
		const directory = path.dirname(file)
		// Line numbers come from line-start offsets, so a link that spans lines reports its first line.
		const lineStarts: number[] = [0]

		for (let index = 0; index < text.length; index++) {
			if (text[index] === "\n") {
				lineStarts.push(index + 1)
			}
		}

		for (const match of text.matchAll(RELATIVE_LINK)) {
			const target = match[1]!

			if (await pathExists(path.resolve(directory, target))) continue

			let line = 1

			while (line < lineStarts.length && lineStarts[line]! <= match.index) {
				line++
			}

			broken.push({ file: path.relative(repoRoot, file), target, line })
		}
	}

	return broken
}
