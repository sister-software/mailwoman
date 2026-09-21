/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Relative links in markdown, resolved against the filesystem.
 *
 *   A markdown link is a string literal no compiler reads, so a directory move repoints the imports and leaves the
 *   prose pointing at nothing. The other docs checks cannot see this class: `collectDocPages()` walks `docs/articles`
 *   alone, and the trees that carry most of the cross-references — `engineering/`, `records/`, `superpowers/` — are
 *   not built by Docusaurus, so no build has ever resolved a path in them.
 *
 *   Scope is deliberately narrow. Only `./` and `../` targets are checked: a bare `docs/x.md` is ambiguous between a
 *   repo-relative path and a Docusaurus doc id, an absolute `/docs/…` is a route rather than a file, and an external
 *   URL is not this check's business. An anchor is stripped before resolution, because a fragment names a heading
 *   inside the target rather than a different file. A target that exists as a directory passes: a link to a folder is
 *   how Docusaurus reaches its index page.
 */

// Node builtins on purpose.
// `check/docs-structure.ts` reaches this file, and the Docs workflow runs it
// before `yarn install`, so no workspace specifier can resolve.
/* oxlint-disable typescript/no-restricted-imports -- runs before `yarn install`; see above */
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
/* oxlint-enable typescript/no-restricted-imports */

import { pathExists } from "./exists.ts"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The docs package root, truncated at the `scripts/` segment rather than counted upward,
 * so moving this file to a different depth still resolves.
 *
 * Same rule as `frontmatter/index.ts`'s `DOCS_ROOT`, and for the same reason.
 */
const DOCS_ROOT = SCRIPT_DIR.slice(0, SCRIPT_DIR.lastIndexOf(`${path.sep}scripts${path.sep}`))

/**
 * Directories under `docs/` that hold generated or installed files rather than authored prose.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", "build", ".docusaurus", "static", "i18n"])

/**
 * A markdown inline link whose target starts with `./` or `../`, with any `#anchor`
 * captured separately so it can be discarded.
 *
 * Reference-style definitions (`[id]: ../x.md`) are out of scope.
 * The docs tree writes none.
 */
const RELATIVE_LINK = /\]\((\.\.?\/[^)#\s]+)(#[^)\s]*)?\)/g

/**
 * One link whose target does not exist.
 */
export interface BrokenLink {
	/**
	 * The file holding the link, relative to the repository root.
	 */
	file: string
	/**
	 * The target exactly as written, anchor excluded.
	 */
	target: string
	/**
	 * 1-indexed line the link sits on.
	 */
	line: number
}

/**
 * Every authored `.md`/`.mdx` under `docs/`, as absolute paths.
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
 * The relative links in `files` whose targets do not exist, reported against `repoRoot`
 * so a finding is a path a reader can open.
 */
export async function findBrokenLinks(
	files: string[],
	repoRoot: string = path.dirname(DOCS_ROOT)
): Promise<BrokenLink[]> {
	const broken: BrokenLink[] = []

	for (const file of files) {
		const text = await readFile(file, "utf8")
		const directory = path.dirname(file)
		// Line numbers come from a prefix count rather than a per-line scan,
		// so a link split across lines still reports the line it starts on.
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
