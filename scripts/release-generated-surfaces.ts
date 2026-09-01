#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate every version-stamped generated document after a release bump (#1891): the man page
 *   (which embeds `mailwoman <version>` in its `.TH` line, so EVERY bump stales it) and the docs CLI
 *   reference (no version stamp today, but generated from the same help tree — regenerating both
 *   keeps one sequence). v9.2.0's release PR failed its `test` run on exactly this: the freshness
 *   guard compared the committed man page's 9.1.0 stamp against the bumped tree.
 *
 *   Runs AFTER `scripts/prepare-release-version.ts` and REQUIRES a compiled tree — the generators
 *   spawn the compiled CLI (the Ink commands cannot run under bare type-stripping), and the caller
 *   compiles rather than trusting whatever `out/` a runner left behind. Prints each generated file's
 *   changed/unchanged state so the prepare job can stage exactly what moved; a second run on the
 *   same tree is a no-op by construction (the generators are deterministic over the compiled CLI).
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { runIfScript } from "@mailwoman/core/scripting"
import { resolvePath } from "path-ts"
import { $ } from "zx"

/**
 * The generated surfaces, each with the generator that owns it. Adding a version-stamped generated document means
 * adding a row here — the prepare job stages exactly these paths.
 */
export const GENERATED_SURFACES = [
	{ file: "packages/mailwoman/man/mailwoman.1", generator: "scripts/generate-man.ts" },
	{ file: "docs/articles/developers/reference/cli.mdx", generator: "docs/scripts/generate-cli-reference.ts" },
] as const

async function releaseGeneratedSurfaces(): Promise<void> {
	const repoRoot = String(repoRootPath())
	const compiledCLI = resolvePath(repoRoot, "packages/mailwoman/out/cli.js")

	if (!(await pathExists(compiledCLI))) {
		throw new Error(
			`release-generated-surfaces: ${compiledCLI} is missing — run \`yarn compile\` first. The generators spawn ` +
				"the compiled CLI, and running against a stale or absent out/ is how a version stamp goes wrong silently."
		)
	}

	const generators = new Set(GENERATED_SURFACES.map((surface) => surface.generator))

	for (const generator of generators) {
		process.stderr.write(`$ node ${generator}\n`)
		await $({ cwd: repoRoot, stdio: "inherit" })`${process.execPath} ${resolvePath(repoRoot, generator)}`
	}

	for (const surface of GENERATED_SURFACES) {
		const status = await $({ cwd: repoRoot })`git status --porcelain -- ${surface.file}`.quiet()
		const changed = status.stdout.trim().length > 0

		process.stderr.write(`${changed ? "changed  " : "unchanged"} ${surface.file}\n`)
	}
}

runIfScript(import.meta, releaseGeneratedSurfaces)
