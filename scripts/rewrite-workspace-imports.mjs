/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

/** Files to rewrite: everything under packages/, recursively, .ts/.tsx. */
function listFiles() {
	const out = execSync("git ls-files packages/", { cwd: repoRoot, encoding: "utf8" })
	return out
		.split("\n")
		.filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
		.map((p) => resolve(repoRoot, p))
}

/** Map intra-monorepo import paths to their new home. Order matters: longer first. */
const scopeRewrites = [
	[/^mailwoman\/core\/resources\/languages$/, "@mailwoman/core/resources/languages"],
	[/^mailwoman\/core\/resources\/db$/, "@mailwoman/core/resources/db"],
	[/^mailwoman\/core\/resources\/whosonfirst$/, "@mailwoman/core/resources/whosonfirst"],
	[/^mailwoman\/core\/resources\/libpostal$/, "@mailwoman/core/resources/libpostal"],
	[/^mailwoman\/core\/resources$/, "@mailwoman/core/resources"],
	[/^mailwoman\/core\/classification$/, "@mailwoman/core/classification"],
	[/^mailwoman\/core\/tokenization$/, "@mailwoman/core/tokenization"],
	[/^mailwoman\/core\/parser$/, "@mailwoman/core/parser"],
	[/^mailwoman\/core\/solver$/, "@mailwoman/core/solver"],
	[/^mailwoman\/core\/formatter$/, "@mailwoman/core/formatter"],
	[/^mailwoman\/core$/, "@mailwoman/core"],
	[/^mailwoman\/utils$/, "@mailwoman/core/utils"],
	[/^mailwoman\/filters$/, "@mailwoman/core/filters"],
	[/^mailwoman\/solvers$/, "@mailwoman/core/solvers"],
	[/^mailwoman\/classifiers$/, "@mailwoman/classifiers"],
]

/** Imports that should become repo-relative paths (root-only modules). */
const rootRelative = {
	"mailwoman/server": "server/index.js",
	"mailwoman/sdk/cli": "sdk/cli.js",
	"mailwoman/sdk/test": "sdk/test/index.js",
	"mailwoman/sdk/repo": "sdk/repo.js",
}

function relIntoRoot(filePath, targetRelative) {
	const fromDir = dirname(filePath)
	const target = resolve(repoRoot, targetRelative)
	let rel = relative(fromDir, target)
	rel = rel.split("\\").join("/")
	if (!rel.startsWith(".")) rel = "./" + rel
	return rel
}

function rewriteSpecifier(spec, filePath) {
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
for (const file of listFiles()) {
	const src = readFileSync(file, "utf8")
	let touched = false
	const out = src.replace(importRe, (match, head, q, spec) => {
		const rewritten = rewriteSpecifier(spec, file)
		if (rewritten == null || rewritten === spec) return match
		touched = true
		return `${head}${q}${rewritten}${q}`
	})
	if (touched) {
		writeFileSync(file, out)
		changed++
	}
}

console.log(`Rewrote imports in ${changed} files.`)
