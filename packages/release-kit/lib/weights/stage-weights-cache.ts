/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a package-shaped weights directory under a `cacheRoot`, so a candidate model can be graded
 *   with its sibling channels fed — `<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`, the
 *   layout `resolveWeights`' cache rung finds and the posture `score-anchor-v2-boards.run.ts` and
 *   `overlay-channel-smoke.ts` both take.
 *
 *   A model includes more than its `.onnx` file. The card declares required channels. Other bundle artifacts provide them.
 *   A model-file-only replacement would score it with the shipped bundle's channels.
 *
 *   By default, the command links each artifact. It writes no bytes and leaves the data root untouched.
 *   `--dereference` copies the artifacts. A board-routed `mwdev_compare` arm requires that copy
 *   because it refuses an artifact resolving outside the cache it was given.
 *   `--from` seeds the layout. `--file`, `--omit`, and `--card` then change it for an A/B comparison.
 *
 *   Usage:
 *     yarn mwops release stage-weights-cache --out <dir> --locale en-gb \
 *       --from packages/neural-weights-en-gb \
 *       --omit locality-surface-lexicon-v6.json \
 *       --file model.onnx=/path/to/candidate.onnx \
 *       --card /path/to/model-card-eval-en-gb.json
 */

import { isFile, pathExists } from "@mailwoman/core/fs/readers"
import { copyFileTo, createSymbolicLink, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { basename, type PathBuilder, resolvePath, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

export interface StageWeightsCacheOptions {
	repoRoot: string
	out: string
	locale: string
	/**
	 * A workspace package directory to seed the layout from.
	 */
	from?: string
	/**
	 * `<name-in-package>=<source path>` entries.
	 *
	 * Override whatever `from` seeded.
	 */
	file: string[]
	/**
	 * Filenames to leave OUT of the staged package — the ablation arm of an A/B.
	 */
	omit: string[]
	/**
	 * Shorthand for `model-card.json=<path>` — the file that gets swapped in nearly every run.
	 */
	card?: string
	clean: boolean
	/**
	 * Copy each artifact's bytes instead of linking to them.
	 *
	 * A board-routed `mwdev_compare` arm refuses an artifact that resolves outside its `weights_cache`,
	 * because a link back to the workspace would grade the installed model under the candidate's name.
	 * A cache assembled for grading therefore needs the bytes.
	 */
	dereference: boolean
	log: (line: string) => void
}

export interface StageWeightsCacheReport {
	cacheRoot: string
	packageDir: string
	linked: number
	staged: string[]
	omitted: string[]
}

export async function stageWeightsCache(options: StageWeightsCacheOptions): Promise<StageWeightsCacheReport> {
	const { repoRoot, log } = options

	if (!options.out) throw new Error("--out <dir> is required")

	const cacheRoot = resolvePath(repoRoot, options.out)
	// The layout comes from the resolver's own `weightsCachePackageDir`
	// rather than a re-typed literal, so the two cannot drift.
	const packageDir = weightsCachePackageDir(cacheRoot, options.locale)

	if (options.clean && (await pathExists(cacheRoot))) {
		await removePathIfPresent(cacheRoot)
	}

	await makeDirectories(packageDir)

	const omit = new Set(options.omit)
	/**
	 * Staged name → source path, seeded from `from` then overridden.
	 *
	 * The last writer wins.
	 * This makes `file` a divergence rather than a conflict.
	 */
	const staged = new Map<string, PathBuilder>()

	if (options.from) {
		const fromDir = resolvePathBuilder(repoRoot, options.from)

		for await (const entry of Globerator.from("*", { cwd: fromDir, absolute: false })) {
			const source = fromDir(entry)

			// Stage files only.
			// A loader does not read package directories as artifacts.
			// A symlinked directory in the layout could make its walk stale.
			if (await isFile(source)) {
				staged.set(entry, source)
			}
		}
	}

	for (const spec of [...options.file, ...(options.card ? [`model-card.json=${options.card}`] : [])]) {
		const eq = spec.indexOf("=")
		const [name, source] = eq === -1 ? [basename(spec), spec] : [spec.slice(0, eq), spec.slice(eq + 1)]

		staged.set(name, resolvePathBuilder(repoRoot, source))
	}

	let linked = 0

	for (const [name, source] of [...staged].toSorted()) {
		if (omit.has(name)) continue

		if (!(await pathExists(source))) {
			log(`WARNING: ${name} → ${source} does not exist, skipping`)

			continue
		}

		await (options.dereference ? copyFileTo(source, packageDir(name)) : createSymbolicLink(source, packageDir(name)))

		linked++
	}

	const stagedNames = [...staged.keys()].toSorted().filter((key) => !omit.has(key))

	log(`staged ${linked} artifact(s) ${options.dereference ? "as copies" : "as links"} → ${packageDir}`)
	log(`  cacheRoot: ${cacheRoot}`)

	for (const entry of stagedNames) {
		log(`  ${entry}`)
	}

	if (omit.size) {
		log(`  OMITTED: ${[...omit].join(", ")}`)
	}

	return {
		cacheRoot,
		packageDir: packageDir.toString(),
		linked,
		staged: stagedNames,
		omitted: [...omit],
	}
}
