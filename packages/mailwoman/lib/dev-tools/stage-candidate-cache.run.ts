/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stage a weights cache that carries the base package AND every locale overlay, so a candidate model is graded on
 *   the path production takes rather than on the base alone.
 *
 *   Why this exists: every candidate cache under `$MAILWOMAN_DATA_ROOT/candidates/` held exactly ONE package,
 *   `neural-weights-en-us`. The gauntlet warns when a routed overlay is absent and grades those cases BASE-ONLY, so
 *   every board read taken through an explicit cache has graded DE, ES, GB, IN, IT and NZ without their pair-index and
 *   deploc priors. A base-only pass is not evidence the production path passes — the overlay changes the prior (#2223).
 *
 *   The layout is npm's, because that is what `resolveWeights` walks: `<out>/node_modules/@mailwoman/<package>/`. Each
 *   staged package carries its workspace `package.json`, so an overlay's `mailwoman.baseWeights` declaration reaches
 *   the resolver and it finds the base model beside it rather than shipping its own. Every other file is a symlink
 *   into `$MAILWOMAN_DATA_ROOT/weights/<locale>/`, except the base's `model.onnx`, which points at the candidate.
 *
 *   A declared file with nothing behind it is REPORTED, not silently skipped and not fatal: the data root legitimately
 *   lacks some declared siblings (en-us's calibration pair is not materialized there), and the harness has its own
 *   guard, `assertDeclaredAnchorBins`, for the ones whose absence changes a score. A cache that names what it does not
 *   carry is a measurement; one that stays quiet is the defect this tool was written for.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/stage-candidate-cache.run.ts --model <int8.onnx> --out <dir>
 *   [--locales en-us,en-gb,…] [--dry-run]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { createSymbolicLink, makeDirectories } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { join } from "path-ts"

const { values } = parseArguments({
	options: {
		model: { type: "string" },
		out: { type: "string" },
		locales: { type: "string", default: "" },
		"dry-run": { type: "boolean", default: false },
	},
})

const modelPath = values.model
const outRoot = values.out

if (!modelPath) throw new Error("--model <int8.onnx> is required: the candidate graph the base package serves")

if (!outRoot) throw new Error("--out <dir> is required: the cache root to stage into")

if (!(await pathExists(modelPath))) {
	throw new Error(`--model names nothing at ${modelPath}`)
}

/**
 * The base package every overlay reaches through `mailwoman.baseWeights`, and the only one that carries a model.
 */
const BASE_LOCALE = "en-us"

/**
 * Locales staged by default: the base plus every overlay the gauntlet's board can route to, which is the set whose
 * absence the harness warns about. `routing.ts` is the authority on which countries route where; this list is the
 * PACKAGE side of it, so an overlay published but unrouted (fr-fr, en-au) can still be staged by naming it.
 */
const DEFAULT_LOCALES = [BASE_LOCALE, "en-gb", "en-nz", "de-de", "en-in", "es-es", "it-it"]

const locales = values.locales
	? values.locales
			.split(",")
			.map((locale) => locale.trim().toLowerCase())
			.filter((locale) => locale.length)
	: DEFAULT_LOCALES

if (!locales.includes(BASE_LOCALE)) {
	throw new Error(
		`--locales must include ${BASE_LOCALE}: every overlay declares it as baseWeights and resolves the model through it`
	)
}

const missingByPackage = new Map<string, string[]>()
let linked = 0

for (const locale of locales) {
	const workspace = repoRootPath("packages", `neural-weights-${locale}`)
	const manifestPath = join(workspace, "package.json")

	if (!(await pathExists(manifestPath))) {
		throw new Error(`no workspace for locale ${locale} at ${workspace}`)
	}

	const manifest = await readPackageJSON(manifestPath)
	const packageDirectory = join(outRoot, "node_modules", "@mailwoman", `neural-weights-${locale}`)

	// The manifest's `files` mixes concrete siblings with globs, negations and the source patterns a published tarball
	// needs. Only the concrete data siblings belong in a cache; a glob has nothing to link.
	const declared = (manifest.files ?? []).filter(
		(entry) => !entry.startsWith("!") && !entry.includes("*") && entry !== "README.md"
	)

	const missing: string[] = []

	if (!values["dry-run"]) {
		await makeDirectories(packageDirectory)
		await createSymbolicLink(manifestPath, join(packageDirectory, "package.json"))
	}

	for (const name of declared) {
		const source = locale === BASE_LOCALE && name === "model.onnx" ? modelPath : dataRootPath("weights", locale, name)

		if (!(await pathExists(source))) {
			missing.push(name)

			continue
		}

		linked += 1

		if (!values["dry-run"]) {
			await createSymbolicLink(source, join(packageDirectory, name))
		}
	}

	if (missing.length) {
		missingByPackage.set(`neural-weights-${locale}`, missing)
	}
}

console.log(`${values["dry-run"] ? "would link" : "linked"} ${linked} file(s) across ${locales.length} package(s)`)
console.log(`  base model: ${modelPath}`)
console.log(`  cache root: ${outRoot}`)

if (missingByPackage.size) {
	console.log("declared but absent from the data root — the cache does NOT carry these:")

	for (const [name, missing] of [...missingByPackage].toSorted(([a], [b]) => a.localeCompare(b))) {
		console.log(`  ${name}: ${missing.join(", ")}`)
	}
}
