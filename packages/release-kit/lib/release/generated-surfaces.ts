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
 *   Runs AFTER `mwops release prepare-version` and REQUIRES a compiled tree — the generators
 *   spawn the compiled CLI (the Ink commands cannot run under bare type-stripping), and the caller
 *   compiles rather than trusting whatever `out/` a runner left behind. Reports each generated file's
 *   changed/unchanged state so the prepare job can stage exactly what moved; a second run on the
 *   same tree is a no-op by construction (the generators are deterministic over the compiled CLI).
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"
import { $ } from "zx"

/**
 * The generated surfaces, each with the generator that owns it. Adding a version-stamped generated document means
 * adding a row here — the prepare job stages exactly these paths.
 */
const GENERATED_SURFACES: ReadonlyArray<{ file: string; generator: readonly string[] }> = [
	{
		file: "packages/mailwoman/man/mailwoman.1",
		generator: ["packages/mailwoman/out/cli.js", "dev", "generate", "man-page"],
	},
	{ file: "docs/articles/developers/reference/cli.mdx", generator: ["docs/scripts/generate-cli-reference.ts"] },
]

export interface GeneratedSurfaceState {
	file: string
	changed: boolean
}

export async function releaseGeneratedSurfaces(
	repoRoot: string,
	log: (line: string) => void
): Promise<GeneratedSurfaceState[]> {
	const compiledCLI = resolvePath(repoRoot, "packages/mailwoman/out/cli.js")

	if (!(await pathExists(compiledCLI))) {
		throw new Error(
			`release-generated-surfaces: ${compiledCLI} is missing — run \`yarn compile\` first. The generators spawn ` +
				"the compiled CLI, and running against a stale or absent out/ is how a version stamp goes wrong silently."
		)
	}

	// Each generator is `node <entry> [args]` with the entry resolved against the repo root; two surfaces sharing a
	// generator run it once.
	const generators = new Map(GENERATED_SURFACES.map((surface) => [surface.generator.join(" "), surface.generator]))

	for (const [entry, ...args] of generators.values()) {
		log(`$ node ${entry} ${args.join(" ")}`.trimEnd())
		await $({ cwd: repoRoot, stdio: "inherit" })`${process.execPath} ${resolvePath(repoRoot, entry!)} ${args}`
	}

	const states: GeneratedSurfaceState[] = []

	for (const surface of GENERATED_SURFACES) {
		const status = await $({ cwd: repoRoot })`git status --porcelain -- ${surface.file}`.quiet()
		const changed = status.stdout.trim().length > 0

		log(`${changed ? "changed  " : "unchanged"} ${surface.file}`)
		states.push({ file: surface.file, changed })
	}

	return states
}
