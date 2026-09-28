/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Plans a module move by resolving specifiers to their targets before and after the move.
 *
 *   Resolution determines a specifier's target. One module can have several spellings — `#recipes/x`,
 *   `@mailwoman/corpus/recipes/x`, and `./x.ts`. A text sweep only finds the spellings it searches for. The planner
 *   resolves each candidate replacement against the filesystem after the move. It writes a replacement only when
 *   resolution reaches the moved file. The planner reports a specifier as unresolved when no candidate reaches that
 *   file. Any unresolved specifier refuses the whole plan because the planner cannot choose a replacement without
 *   evidence from the author reviewing the diff.
 *
 *   Text narrows the files that need parsing. The planner skips a file when its source contains no spelling of a
 *   moved module. It probes the moved file's basename and every specifier its package maps can express for that file.
 *   This includes files that refer to the module through a subpath key that hides the filename.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { basename, dirname, resolvePath } from "path-ts"
import ts from "typescript"

import type { RepoContext } from "#check"
import { planPathLiteralRewrites } from "#move/literals"
import { planManifestRewrites } from "#move/manifests"
import { createMoveResolver } from "#move/resolution"
import {
	hasSourceExtension,
	orderByLikeness,
	packageSpecifiersFor,
	relativeSpecifier,
	specifierFamily,
	SpecifierFamily,
	type PackageManifest,
} from "#move/specifiers"
import { spliceText } from "#move/splice"
import type { ModuleMove, ModuleMovePlan, SpecifierRewrite, UnresolvedSpecifier } from "#move/types"
import { trackedSourcePaths } from "#tracked-sources"
import { moduleSpecifierLiterals } from "#ts-ast"

const SOURCE_STEM = /\.(?:m|c)?[jt]sx?$/u

/**
 * Every tracked `package.json`, read as a manifest.
 *
 * The repository requires a file read rather than an import for a different reason —
 * a JSON import lands in `out/` and rewrites the package scope of the compiled tree —
 * and it is the only form available here anyway, since the set is discovered at runtime.
 */
export async function readPackageManifests(context: RepoContext): Promise<PackageManifest[]> {
	const files = context.trackedFiles.filter((file) => file.endsWith("/package.json") && !file.includes("node_modules/"))

	const manifests = await Promise.all(
		files.map(async (file) => {
			const manifest = await readLocalJSONFile<{
				name?: string
				imports?: Record<string, unknown>
				exports?: Record<string, unknown>
			}>(resolvePath(context.repoRoot, file))

			if (!manifest.name) return null

			return {
				dir: dirname(file),
				name: manifest.name,
				imports: manifest.imports,
				exports: manifest.exports,
			} satisfies PackageManifest
		})
	)

	return manifests.filter(isPresent)
}

/**
 * The manifest whose directory contains `file`, taking the deepest one
 * so a nested workspace wins over its parent.
 */
function owningManifest(manifests: readonly PackageManifest[], file: string): PackageManifest | undefined {
	let owner: PackageManifest | undefined

	for (const manifest of manifests) {
		if (!file.startsWith(`${manifest.dir}/`)) continue

		if (!owner || manifest.dir.length > owner.dir.length) {
			owner = manifest
		}
	}

	return owner
}

/**
 * Text a file must contain before it is worth parsing for references to `move.from`.
 */
function referenceProbes(move: ModuleMove, manifests: readonly PackageManifest[]): string[] {
	const stem = basename(move.from).replace(SOURCE_STEM, "")
	const probes = [stem === "index" ? basename(dirname(move.from)) : stem]
	const owner = owningManifest(manifests, move.from)

	if (owner) {
		const { internal, bare } = packageSpecifiersFor(owner, move.from)

		probes.push(...internal, ...bare)
	}

	return probes
}

/**
 * Replacement specifiers to try, in the order they should be tried,
 * all in the family `specifier` is written in.
 */
function candidateReplacements(
	specifier: string,
	containingFile: string,
	target: string,
	manifests: readonly PackageManifest[]
): string[] {
	const family = specifierFamily(specifier)

	if (family === SpecifierFamily.Relative) {
		return [relativeSpecifier(containingFile, target, hasSourceExtension(specifier))]
	}

	const owner = owningManifest(manifests, target)

	if (!owner) return []

	if (family === SpecifierFamily.Internal) {
		// A `#` specifier is package-private: it can only be written by a file the same package owns.
		if (owningManifest(manifests, containingFile)?.dir !== owner.dir) return []

		return orderByLikeness(specifier, packageSpecifiersFor(owner, target).internal)
	}

	return orderByLikeness(specifier, packageSpecifiersFor(owner, target).bare)
}

/**
 * Read every move against the checkout in `context` and answer what would have to change.
 *
 * The plan is complete before anything is written.
 * `moves` lists file renames.
 *
 * `rewrites` lists specifier edits and their offsets.
 * `unresolved` lists specifiers with no replacement proven by resolution.
 */
export async function planModuleMoves(context: RepoContext, moves: readonly ModuleMove[]): Promise<ModuleMovePlan> {
	const manifests = await readPackageManifests(context)
	const destinations = new Map(moves.map((move) => [move.from, move.to]))

	// The manifest edits come first: the overlay the replacements are proven against has
	// to be the tree the whole plan leaves behind, subpath targets included.
	const manifestRewrites = await planManifestRewrites(
		context.repoRoot,
		manifests.map((manifest) => manifest.dir),
		moves
	)

	const rewrittenManifests = new Map<string, string>()

	for (const [file, edits] of Map.groupBy(manifestRewrites, (rewrite) => rewrite.file)) {
		const text = await readLocalTextFile(resolvePath(context.repoRoot, file))

		rewrittenManifests.set(
			file,
			spliceText(
				file,
				text,
				edits.map((edit) => ({ ...edit, expected: edit.target, quoted: true }))
			)
		)
	}

	// Candidates are derived from the maps the plan leaves rather than the ones it found:
	// a target that has moved would otherwise offer a replacement naming the old path, or none at all.
	const planned = manifests.map((manifest) => {
		const text = rewrittenManifests.get(`${manifest.dir}/package.json`)

		if (!text) return manifest

		// A manifest this operation just spliced must parse.
		// If it does not, the splice was wrong and the plan is void.
		const parsed = parseJSONStrict<Pick<PackageManifest, "imports" | "exports">>(text)

		return { ...manifest, imports: parsed.imports, exports: parsed.exports }
	})

	const before = createMoveResolver(context.repoRoot, [])
	const after = createMoveResolver(context.repoRoot, moves, rewrittenManifests)
	const probes = moves.flatMap((move) => referenceProbes(move, manifests))

	const tracked = (await trackedSourcePaths(context, { existingOnly: true })).map((path) =>
		path.startsWith(`${context.repoRoot}/`) ? path.slice(context.repoRoot.length + 1) : path
	)

	const rewrites: SpecifierRewrite[] = []
	const unresolved: UnresolvedSpecifier[] = []
	let read = 0

	for (const file of tracked) {
		const text = await readLocalTextFile(resolvePath(context.repoRoot, file))
		const moved = destinations.get(file)

		if (!moved && !probes.some((probe) => text.includes(probe))) continue

		read++

		const containing = moved ?? file
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)

		for (const literal of moduleSpecifierLiterals(source, { includeTypeOnly: true })) {
			const specifier = literal.text
			const current = before.resolve(specifier, file)

			if (!current) continue

			const target = destinations.get(current) ?? current

			if (after.resolve(specifier, containing) === target) continue

			const candidates = candidateReplacements(specifier, containing, target, planned)
			const replacement = candidates.find((candidate) => after.resolve(candidate, containing) === target)

			if (!replacement) {
				unresolved.push({
					file: containing,
					specifier,
					reason: candidates.length
						? `no candidate resolved to ${target}: ${candidates.join(", ")}`
						: `no ${specifierFamily(specifier)} specifier names ${target}`,
				})

				continue
			}

			if (replacement === specifier) continue

			rewrites.push({
				file: containing,
				specifier,
				replacement,
				target,
				start: literal.getStart(source),
				end: literal.getEnd(),
			})
		}
	}

	const pathLiterals = await planPathLiteralRewrites(context.repoRoot, context.trackedFiles, moves)

	return {
		moves: [...moves],
		rewrites,
		manifestRewrites,
		pathLiterals,
		unresolved,
		scanned: { read, tracked: tracked.length },
	}
}
