#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The tracked-file entry point for the repository's Vale prose surfaces.
 *
 *   The package scripts stay declarative. This file owns the pathspecs, asks the shared git reader for the index's
 *   file set, and invokes Vale through the shared process boundary.
 */

/// <reference types="node" />

import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { valeCommand } from "@mailwoman/core/vale"

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

async function main(args: readonly string[]): Promise<number> {
	const selectedSurface = surface(args[0])
	// Narrowing paths, for a caller that has just edited a file and wants the same verdict CI would give it. They are
	// intersected with the surface's pathspecs rather than linted directly, so an excluded path stays excluded and the
	// caller never has to carry a second copy of the exclusion list.
	const narrowing = args.slice(1)
	const surfaceFiles = await trackedFiles(REPO_ROOT, pathspecsFor(selectedSurface))

	if (!surfaceFiles.length) throw new Error(`No tracked files matched the ${selectedSurface} Vale surface`)

	const files = narrowTo(surfaceFiles, narrowing)

	// A narrowed run matching nothing is the ordinary answer for a path this surface excludes, or for one git does not
	// track yet, so it reports clean rather than raising.
	if (!files.length) return 0

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
