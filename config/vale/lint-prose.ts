#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The tracked-file entry point for the repository's Vale prose surfaces.
 *
 *   The package scripts stay declarative. This file owns the pathspecs, asks the shared git reader for the index's
 *   file set, and invokes Vale through the shared process boundary. No shell parses a file list here.
 */

import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { valeCommand } from "@mailwoman/core/vale"

type Surface = "docs" | "docs-vocab" | "code"

const REPO_ROOT = repoRootPath()

const DOC_EXCLUDES = [
	":(exclude)config/vale/fixtures/**",
	":(exclude).agents/skills/**",
	":(exclude)corpus-python/**/AGENTS.md",
	":(exclude)corpus-python/**/CLAUDE.md",
	":(exclude)packages/**/AGENTS.md",
	":(exclude)packages/**/CLAUDE.md",
	":(exclude)CHANGELOG.md",
	":(exclude)**/CHANGELOG.md",
	":(exclude)LICENSE.md",
	":(exclude)**/LICENSE.md",
	":(exclude)COMMERCIAL-LICENSE.md",
	":(exclude)**/COMMERCIAL-LICENSE.md",
	":(exclude)CODE_OF_CONDUCT.md",
	":(exclude)**/CODE_OF_CONDUCT.md",
	":(exclude)SECURITY.md",
	":(exclude)**/SECURITY.md",
	":(exclude)THIRD_PARTY_NOTICES.md",
	":(exclude)**/THIRD_PARTY_NOTICES.md",
	":(exclude)packages/**/data/PROVENANCE.md",
	":(exclude)packages/**/lib/**/*.md",
	":(exclude)packages/mailwoman/skills/**",
	":(exclude)packages/mailwoman/lib/eval-harness/**",
	":(exclude)packages/resolver-wof-sqlite/CONVENTION.md",
	":(exclude)packages/resolver-wof-sqlite/POSTCODE-*.md",
]

const CODE_EXCLUDES = [
	":(exclude)config/vale/**",
	":(exclude)docs/**/test-fixtures/**",
	":(exclude)packages/**/test-fixtures/**",
	":(exclude)packages/neural/test/fixtures/**",
	":(exclude)packages/mailwoman/lib/eval-harness/conformance/fixture.ts",
	":(exclude).yarnrc.yml",
	":(exclude)docker/docker-compose.yml",
	":(exclude)docs/tags.yml",
]

function surface(value: string | undefined): Surface {
	if (value === "docs" || value === "docs-vocab" || value === "code") return value

	throw new Error("Usage: node config/vale/lint-prose.ts <docs|docs-vocab|code> [path ...]")
}

function pathspecsFor(value: Surface): string[] {
	return value === "code"
		? ["*.ts", "*.tsx", "*.py", "*.yaml", "*.yml", ...CODE_EXCLUDES]
		: ["*.md", "*.mdx", ...DOC_EXCLUDES]
}

/**
 * The surface's files narrowed to the ones a caller named.
 *
 * The intersection is taken HERE rather than by handing the paths to git beside the exclude pathspecs. Git's default
 * pathspec magic lets a star cross a slash, and a literal path combined with the recursive `test-fixtures` exclude in
 * `DOC_EXCLUDES` selects nothing at all: measured on `packages/core/lib/module/compiled-freshness.ts`, which that
 * exclude cannot name, the pair answered zero files. A narrowed run would then report clean on a file it never opened,
 * which is the reading this whole surface exists to prevent. Comparing strings has no such rule.
 */
function narrowTo(files: readonly string[], narrowing: readonly string[]): string[] {
	if (!narrowing.length) return [...files]

	const wanted = new Set(narrowing.map((path) => path.replace(/^\.\//, "")))

	return files.filter((file) => wanted.has(file))
}

function configFor(value: Surface): string {
	return value === "code"
		? "config/vale/.vale-code.ini"
		: value === "docs"
			? "config/vale/.vale.ini"
			: "config/vale/.vale-vocab.ini"
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
