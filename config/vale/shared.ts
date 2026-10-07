/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Shared utilities for Vale.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { workingTreeFiles } from "@mailwoman/core/git"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * Vale configuration surfaces.
 */
export const Surface = {
	Docs: "docs",
	Vocab: "docs-vocab",
	Code: "code",
	CodeTerms: "code-terms",
} as const

export type Surface = (typeof Surface)[keyof typeof Surface]

function prependExclude<T extends string>(path: T) {
	return `:(exclude)${path}` as const
}

export function loadValeIgnore(filePath: PathBuilder) {
	return TextSpliterator.fromAsync(filePath)
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map(prependExclude)
		.toArray()
}

/**
 * The surface's files narrowed to the ones a caller named.
 *
 * We intersect here instead of passing the caller paths to git with the exclude pathspecs.
 *
 * Why: git pathspec rules can produce false negatives when literals and recursive excludes are combined.
 * In practice, a literal path plus the recursive `test-fixtures` exclude in `DOC_EXCLUDES`
 * can return zero matches even when the literal file is unrelated to that exclude
 * (for example `packages/core/lib/module/compiled-freshness.ts`).
 *
 * If we trusted that result, a narrowed run could report clean for a file Vale never read.
 * String-set intersection avoids that pathspec behavior and keeps narrowing deterministic.
 */
export function narrowTo(files: readonly string[], narrowing: readonly string[]): string[] {
	if (!narrowing.length) return [...files]

	const wanted = new Set(narrowing.map((path) => path.replace(/^\.\//, "").replace(/\/$/, "")))
	// A named directory reaches every file under it, so a sweep over one runs as one command.
	// Without this a directory matches no file, because the surface lists files alone.
	const prefixes = [...wanted].map((path) => `${path}/`)

	return files.filter((file) => wanted.has(file) || prefixes.some((prefix) => file.startsWith(prefix)))
}

const ValeSurfaceConfigPath = {
	code: ".vale-code.ini",
	"code-terms": ".vale-code-terms.ini",
	docs: ".vale.ini",
	"docs-vocab": ".vale-vocab.ini",
} as const satisfies Record<Surface, string>

export function assertSurfaceArg(input: string | null): asserts input is Surface {
	if (!input || !Object.hasOwn(ValeSurfaceConfigPath, input)) {
		throw new Error(
			`Usage: node config/vale/lint-prose.ts <${Object.keys(ValeSurfaceConfigPath).join("|")}> [path ...]`
		)
	}
}

export function configFor(value: Surface) {
	return repoRootPathBuilder("config", "vale", ValeSurfaceConfigPath[value])
}

/**
 * Each named path that reached no file, with the reason it did.
 *
 * Three causes produce one empty set and want three different repairs.
 * A path absent from the working tree is a typo or a stale reference.
 *
 * A path an ignore rule covers is a build output, and linting one would report
 * findings its author cannot act on.
 * A path present and carried by git is one this surface excludes by design,
 * which is the only case where silence was ever the right answer.
 *
 * The second `git ls-files` runs only when something failed to match,
 * so an ordinary invocation pays for one.
 */
export async function describeUnmatched(
	narrowing: readonly string[],
	matched: readonly string[],
	surface: Surface
): Promise<string[]> {
	const found = new Set(matched)

	// A directory reaches its files rather than itself, so a named directory that
	// matched anything is satisfied and only an empty one is reported.
	const missing = narrowing
		.map((path) => path.replace(/^\.\//, "").replace(/\/$/, ""))
		.filter((path) => !found.has(path) && !matched.some((file) => file.startsWith(`${path}/`)))

	if (!missing.length) return []

	const carried = new Set(await workingTreeFiles())

	return Promise.all(
		missing.map(async (path) => {
			if (!(await pathExists(repoRootPathBuilder(path)))) {
				return `${path} — no such file in the working tree`
			}

			if (!carried.has(path)) {
				return `${path} — an ignore rule covers it, so it is a build output rather than prose to check.`
			}

			return `${path} — excluded from the ${surface} surface by design.`
		})
	)
}
