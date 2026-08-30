/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a package-shaped weights directory under a `cacheRoot`, so a CANDIDATE model can be graded
 *   with its sibling channels fed — `<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`, the
 *   layout `resolveWeights`' cache rung finds and the posture `score-anchor-v2-boards.run.ts` and
 *   `overlay-channel-smoke.ts` both take.
 *
 *   WHY THIS EXISTS RATHER THAN "just point --model at the checkpoint". A model is not its `.onnx`. The
 *   card declares which channels it needs, and the SIBLINGS (anchor binary, four lexicons, FST, pair
 *   index) are what feed them; grading a candidate by swapping the model file alone silently scores it
 *   with the SHIPPED bundle's channels — the #566/#685 trap one level up. Staging the whole set into a
 *   throwaway directory is what makes "this is the bundle, graded as a bundle" checkable.
 *
 *   Symlinks by default (nothing is copied, nothing in the data root is touched). `--from` seeds the
 *   layout from an existing workspace package; `--file`, `--omit` and `--card` then diverge it. That
 *   `seed + diverge` shape is what an A/B needs: the two arms differ in exactly the files named on the
 *   command line, and the diff is the command line.
 *
 *   Usage:
 *     node scripts/stage-weights-cache.ts --out <dir> --locale en-gb \
 *       --from neural-weights-en-gb \
 *       --omit locality-surface-lexicon-v6.json \
 *       --file model.onnx=/path/to/candidate.onnx \
 *       --card /path/to/model-card-eval-en-gb.json
 */

import { pathExists, readDirectory, statPath } from "@mailwoman/core/fs/readers"
import { createSymbolicLink, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { basename, isAbsolute, join, resolve } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"

const { values } = parseArgs({
	options: {
		out: { type: "string" },
		locale: { type: "string", default: "en-us" },
		from: { type: "string" },
		/**
		 * `<name-in-package>=<source path>`, repeatable. Overrides whatever `--from` seeded.
		 */
		file: { type: "string", multiple: true, default: [] },
		/**
		 * A filename to leave OUT of the staged package, repeatable. The ablation arm of an A/B.
		 */
		omit: { type: "string", multiple: true, default: [] },
		/**
		 * Shorthand for `--file model-card.json=<path>` — the file that gets swapped in nearly every run.
		 */
		card: { type: "string" },
		clean: { type: "boolean", default: true },
	},
})

if (!values.out) throw new Error("--out <dir> is required")
// The layout comes from the resolver's own `weightsCachePackageDir` rather than a re-typed literal
// (2026-08-06 triage) — this script's whole contract is "lay out the directory `resolveWeights`'
// cache rung finds", so the two must not be able to drift.
const packageDir = weightsCachePackageDir(resolve(values.out), values.locale)

if (values.clean && (await pathExists(resolve(values.out)))) {
	await removePathIfPresent(resolve(values.out))
}

await makeDirectories(packageDir)

const omit = new Set(values.omit)
/**
 * Staged name → source path. Seeded from `--from`, then overridden; last writer wins, which is what makes `--file` a
 * divergence rather than a conflict.
 */
const staged = new Map<string, string>()

if (values.from) {
	const fromDir = resolve(values.from)

	for (const entry of await readDirectory(fromDir)) {
		const source = join(fromDir, entry)

		// Files only: `scripts/` and any other directory in a workspace package is not part of the
		// artifact set a loader reads, and symlinking a directory into the layout invites a stale walk.
		if ((await statPath(source)).isFile()) {
			staged.set(entry, source)
		}
	}
}

for (const spec of [...values.file, ...(values.card ? [`model-card.json=${values.card}`] : [])]) {
	const eq = spec.indexOf("=")
	const [name, source] = eq === -1 ? [basename(spec), spec] : [spec.slice(0, eq), spec.slice(eq + 1)]

	staged.set(name, isAbsolute(source) ? source : resolve(source))
}

let linked = 0

for (const [name, source] of [...staged].toSorted()) {
	if (omit.has(name)) continue

	if (!(await pathExists(source))) {
		console.error(`WARNING: ${name} → ${source} does not exist, skipping`)

		continue
	}

	await createSymbolicLink(source, join(packageDir, name))

	linked++
}

console.log(`staged ${linked} artifact(s) → ${packageDir}`)
console.log(`  cacheRoot: ${resolve(values.out)}`)

for (const entry of [...staged.keys()].toSorted().filter((key) => !omit.has(key))) {
	console.log(`  ${entry}`)
}

if (omit.size) {
	console.log(`  OMITTED: ${[...omit].join(", ")}`)
}
