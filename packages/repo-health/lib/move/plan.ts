/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Planning a module move: which specifiers stop naming what they named, and what each becomes.
 *
 *   A specifier is claimed by RESOLUTION, never by its text. Two files can spell one module three ways — `#recipes/x`,
 *   `@mailwoman/corpus/recipes/x`, `./x.ts` — and a text sweep finds whichever spelling it was told to look for. So
 *   every candidate replacement is resolved against a filesystem where the move has already happened, and it is
 *   written only if it lands on the moved file. A specifier with no candidate that lands there is reported unresolved,
 *   and an unresolved specifier refuses the whole plan: this operation has no way to guess that is better than the
 *   author's next reading of the diff.
 *
 *   Text is used for ONE thing, and only to save work: a file whose source contains no spelling of a moved module is
 *   not parsed. The probes are the moved file's own basename plus every specifier its package's maps can express for
 *   it, so a file that references it through a subpath key is read even when the key hides the filename.
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
 * Every tracked `package.json`, read as a manifest. Reading the file rather than importing it is the rule this
 * repository enforces elsewhere for a different reason — a JSON import lands in `out/` and rewrites the package scope
 * of the compiled tree — and it is the only form available here anyway, since the set is discovered at runtime.
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
				dir: String(dirname(file)),
				name: manifest.name,
				imports: manifest.imports,
				exports: manifest.exports,
			} satisfies PackageManifest
		})
	)

	return manifests.filter(isPresent)
}

/**
 * The manifest whose directory contains `file`, taking the deepest one so a nested workspace wins over its parent.
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
	const stem = String(basename(move.from)).replace(SOURCE_STEM, "")
	const probes = [stem === "index" ? String(basename(String(dirname(move.from)))) : stem]
	const owner = owningManifest(manifests, move.from)

	if (owner) {
		const { internal, bare } = packageSpecifiersFor(owner, move.from)

		probes.push(...internal, ...bare)
	}

	return probes
}

/**
 * Replacement specifiers to try, in the order they should be tried, all in the family `specifier` is written in.
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
 * The plan is complete before anything is written: `moves` are the file renames, `rewrites` the specifier edits with
 * their offsets, and `unresolved` the specifiers no proven replacement was found for.
 */
export async function planModuleMoves(context: RepoContext, moves: readonly ModuleMove[]): Promise<ModuleMovePlan> {
	const manifests = await readPackageManifests(context)
	const destinations = new Map(moves.map((move) => [move.from, move.to]))

	// The manifest edits come first: the overlay the replacements are proven against has to be the tree the WHOLE
	// plan leaves behind, subpath targets included.
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

	// Candidates are derived from the maps the plan LEAVES, not the ones it found: a target that has moved would
	// otherwise offer a replacement naming the old path, or none at all.
	const planned = manifests.map((manifest) => {
		const text = rewrittenManifests.get(`${manifest.dir}/package.json`)

		if (!text) return manifest

		// A manifest this operation just spliced must parse. If it does not, the splice was wrong and the plan is void.
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
