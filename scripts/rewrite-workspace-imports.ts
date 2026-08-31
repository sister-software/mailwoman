/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/utils"
import { dirname, relative, resolvePath } from "path-ts"

import { trackedSourcePaths } from "./tracked-sources.ts"

const repoRoot = repoRootPath()

/**
 * Files to rewrite: every tracked .ts/.tsx under packages/, declarations included.
 */
function listFiles() {
	return trackedSourcePaths(String(repoRoot), { prefix: "packages/", includeDeclarations: true })
}

/**
 * Map intra-monorepo import paths to their new home. Order matters: longer first.
 */
const scopeRewrites: Array<[RegExp, string]> = [
	[/^mailwoman\/core\/resources\/languages$/, "@mailwoman/core/resources/languages"],
	[/^mailwoman\/core\/resources\/db$/, "@mailwoman/core/resources/db"],
	[/^mailwoman\/core\/resources\/whosonfirst$/, "@mailwoman/core/resources/whosonfirst"],
	[/^mailwoman\/core\/resources\/libpostal$/, "@mailwoman/core/resources/libpostal"],
	[/^mailwoman\/core\/resources$/, "@mailwoman/core/resources"],
	[/^mailwoman\/core\/tokenization$/, "@mailwoman/core/tokenization"],
	[/^mailwoman\/core\/formatter$/, "@mailwoman/core/formatter"],
	[/^mailwoman\/core$/, "@mailwoman/core"],
	[/^mailwoman\/utils$/, "@mailwoman/core/utils"],
	[/^mailwoman\/filters$/, "@mailwoman/core/filters"],
	[/^mailwoman\/solvers$/, "@mailwoman/core/solvers"],
]

/**
 * Imports that should become repo-relative paths (root-only modules).
 */
const rootRelative: Record<string, string> = {
	"mailwoman/cli-kit": "cli-kit/index.js",
	"mailwoman/test-kit": "test-kit/index.js",
}

function relIntoRoot(filePath: string, targetRelative: string) {
	const fromDir = dirname(filePath)
	const target = resolvePath(repoRoot, targetRelative)
	let rel = relative(fromDir, target)
	rel = rel.split("\\").join("/")

	if (!rel.startsWith(".")) {
		rel = "./" + rel
	}

	return rel
}

function rewriteSpecifier(spec: string, filePath: string) {
	if (rootRelative[spec]) {
		return relIntoRoot(filePath, rootRelative[spec])
	}

	for (const [pattern, replacement] of scopeRewrites) {
		if (pattern.test(spec)) {
			return spec.replace(pattern, replacement)
		}
	}

	return null
}

const importRe = /(from\s+|require\(\s*)(["'])([^"'\n]+)\2/g

let changed = 0

for (const file of await listFiles()) {
	const src = await readLocalTextFile(file)
	let touched = false

	const out = src.replace(importRe, (match, head, q, spec) => {
		const rewritten = rewriteSpecifier(spec, file)

		if (rewritten == null || rewritten === spec) return match
		touched = true

		return `${head}${q}${rewritten}${q}`
	})

	if (touched) {
		await writeLocalFile(out, file)

		changed++
	}
}

console.log(`Rewrote imports in ${changed} files.`)
