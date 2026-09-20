#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The working-tree entry point for the repository's Vale prose surfaces.
 *
 *   The package scripts stay declarative. This file owns the pathspecs, asks the shared git reader for the working
 *   tree's file set, and invokes Vale through the shared process boundary.
 *
 *   It reads the working tree rather than the index, so a file written a minute ago is checked. Reading the index
 *   meant a newly created file reached no surface, produced an empty file list, and exited clean without Vale opening
 *   it — and the editor hook that calls this reports findings off Vale's own summary, so it stayed silent too.
 */

/// <reference types="node" />

import { pathExists } from "@mailwoman/core/fs/readers"
import { workingTreeFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { valeCommand } from "@mailwoman/core/vale"
import { resolvePath } from "path-ts"

type Surface = "docs" | "docs-vocab" | "code"

const REPO_ROOT = repoRootPath()

const prependExclude = (path: string) => `:(exclude)${path}`

const DOC_EXCLUDES = [
	"config/vale/fixtures/**",
	".agents/skills/**",
	"corpus-python/**/AGENTS.md",
	"corpus-python/**/CLAUDE.md",
	"packages/**/AGENTS.md",
	"packages/**/CLAUDE.md",
	"CHANGELOG.md",
	"**/CHANGELOG.md",
	"LICENSE.md",
	"**/LICENSE.md",
	"COMMERCIAL-LICENSE.md",
	"**/COMMERCIAL-LICENSE.md",
	"CODE_OF_CONDUCT.md",
	"**/CODE_OF_CONDUCT.md",
	"SECURITY.md",
	"**/SECURITY.md",
	"THIRD_PARTY_NOTICES.md",
	"**/THIRD_PARTY_NOTICES.md",
	"packages/**/data/PROVENANCE.md",
	"packages/**/lib/**/*.md",
	"packages/mailwoman/skills/**",
	"packages/mailwoman/lib/eval-harness/**",
	"packages/resolver-wof-sqlite/CONVENTION.md",
	"packages/resolver-wof-sqlite/POSTCODE-*.md",
].map(prependExclude)

const CODE_EXCLUDES = [
	"config/vale/**",
	"docs/**/test-fixtures/**",
	"packages/**/test-fixtures/**",
	"packages/neural/test/fixtures/**",
	"packages/mailwoman/lib/eval-harness/conformance/fixture.ts",
	".yarnrc.yml",
	"docker/docker-compose.yml",
	"docs/tags.yml",
].map(prependExclude)

function surface(value: string | undefined): Surface {
	if (value === "docs" || value === "docs-vocab" || value === "code") return value

	throw new Error("Usage: node config/vale/lint-prose.ts <docs|docs-vocab|code> [path ...]")
}

function pathspecsFor(value: Surface): string[] {
	switch (value) {
		case "code":
			return ["*.ts", "*.tsx", "*.py", "*.yaml", "*.yml", ...CODE_EXCLUDES]
		default:
			return ["*.md", "*.mdx", ...DOC_EXCLUDES]
	}
}

/**
 * The surface's files narrowed to the ones a caller named.
 *
 * We intersect here instead of passing the caller paths to git with the exclude pathspecs.
 *
 * Why: git pathspec rules can produce false negatives when literals and recursive excludes are combined. In practice, a
 * literal path plus the recursive `test-fixtures` exclude in `DOC_EXCLUDES` can return zero matches even when the
 * literal file is unrelated to that exclude (for example `packages/core/lib/module/compiled-freshness.ts`).
 *
 * If we trusted that result, a narrowed run could report clean for a file Vale never read. String-set intersection
 * avoids that pathspec behavior and keeps narrowing deterministic.
 */
function narrowTo(files: readonly string[], narrowing: readonly string[]): string[] {
	if (!narrowing.length) return [...files]

	const wanted = new Set(narrowing.map((path) => path.replace(/^\.\//, "")))

	return files.filter((file) => wanted.has(file))
}

function configFor(value: Surface): string {
	switch (value) {
		case "code":
			return "config/vale/.vale-code.ini"
		case "docs":
			return "config/vale/.vale.ini"
		case "docs-vocab":
			return "config/vale/.vale-vocab.ini"
	}
}

/**
 * Each named path that reached no file, with the reason it did.
 *
 * Three causes produce one empty set and want three different repairs. A path absent from the working tree is a typo or
 * a stale reference. A path an ignore rule covers is a build output, and linting one would report findings its author
 * cannot act on. A path present and carried by git is one this surface excludes by design, which is the only case where
 * silence was ever the right answer.
 *
 * The second `git ls-files` runs only when something failed to match, so an ordinary invocation pays for one.
 */
async function describeUnmatched(
	narrowing: readonly string[],
	matched: readonly string[],
	selectedSurface: Surface
): Promise<string[]> {
	const found = new Set(matched)
	const missing = narrowing.map((path) => path.replace(/^\.\//, "")).filter((path) => !found.has(path))

	if (!missing.length) return []

	const carried = new Set(await workingTreeFiles(REPO_ROOT))

	return Promise.all(
		missing.map(async (path) => {
			if (!(await pathExists(resolvePath(REPO_ROOT, path)))) {
				return `${path} — no such file in the working tree`
			}

			if (!carried.has(path)) {
				return `${path} — an ignore rule covers it, so it is a build output rather than prose to check.`
			}

			return `${path} — excluded from the ${selectedSurface} surface by design.`
		})
	)
}

async function main(args: readonly string[]): Promise<number> {
	const selectedSurface = surface(args[0])
	// Narrowing paths, for a caller that has just edited a file and wants the same verdict CI would give it. They are
	// intersected with the surface's pathspecs rather than linted directly, so an excluded path stays excluded and the
	// caller never has to carry a second copy of the exclusion list.
	const narrowing = args.slice(1)
	// The working tree rather than the index. A file written a minute ago carries prose nobody has read, and reading
	// the committed list reported it clean without opening it. `--exclude-standard` keeps build outputs out.
	const surfaceFiles = await workingTreeFiles(REPO_ROOT, pathspecsFor(selectedSurface))

	if (!surfaceFiles.length) throw new Error(`No files in the working tree matched the ${selectedSurface} Vale surface`)

	const files = narrowTo(surfaceFiles, narrowing)

	// A named path that reaches no file is reported rather than passed over. Returning 0 here answered "no findings"
	// to a question Vale was never asked: the surface list comes from `git ls-files`, so naming an untracked file
	// produced an empty set, printed nothing and exited clean. A new file's prose is exactly what a caller wants read,
	// and this reported it as read and clean instead.
	//
	// Each unmatched path carries the reason it matched nothing, because the three cases need different repairs and a
	// bare count distinguishes none of them.
	if (narrowing.length) {
		const unmatched = await describeUnmatched(narrowing, files, selectedSurface)

		if (unmatched.length) {
			throw new Error(
				`${unmatched.length} of ${narrowing.length} named paths reached no file in the ${selectedSurface} ` +
					`surface, so Vale did not read them:\n  ${unmatched.join("\n  ")}`
			)
		}
	}

	const vale = await valeCommand(import.meta.url)

	try {
		const result = await runFile(vale.file, [...vale.argv, "--config", configFor(selectedSurface), ...files], {
			cwd: REPO_ROOT,
			maxBuffer: 50 * 1024 * 1024,
		})

		process.stdout.write(result.stdout)
		process.stderr.write(result.stderr)

		return 0
	} catch (error: unknown) {
		if (!isProcessError(error)) throw error

		process.stdout.write(error.stdout)
		process.stderr.write(error.stderr)

		return typeof error.code === "number" ? error.code : 1
	}
}

process.exitCode = await runCLICommand(() => main(cliArguments()))
