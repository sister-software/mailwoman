/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A declared file with no artifact behind it is reported rather than silently skipped and is not
 *   fatal, because the data root legitimately lacks some declared siblings.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { createSymbolicLink, makeDirectories } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { workspacePathBuilder } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { TextSpliterator } from "spliterator"

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
 * The base package every overlay reaches through `mailwoman.baseWeights`,
 * and the only one that contains a model.
 */
const BASE_LOCALE = "en-us"

/**
 * The default set includes the base and every overlay the gauntlet's board can route to.
 *
 * The harness warns when a locale in this set is missing.
 * `routing.ts` defines routing behavior.
 */
const DEFAULT_LOCALES = [BASE_LOCALE, "en-gb", "en-nz", "de-de", "en-in", "es-es", "it-it"]

const locales = values.locales
	? TextSpliterator.from(values.locales, { delimiter: "," })
			.map((locale) => locale.toLowerCase())
			.toArray()
	: DEFAULT_LOCALES

if (!locales.includes(BASE_LOCALE)) {
	throw new Error(
		`--locales must include ${BASE_LOCALE}: every overlay declares it as baseWeights and resolves the model through it`
	)
}

const missingByPackage = new Map<string, string[]>()
let linked = 0

for (const locale of locales) {
	const workspace = workspacePathBuilder(`neural-weights-${locale}`)
	const manifestPath = workspace("package.json")

	if (!(await pathExists(manifestPath))) {
		throw new Error(`no workspace for locale ${locale} at ${workspace}`)
	}

	const manifest = await readPackageJSON(manifestPath)
	// `weightsCachePackageDir` defines the npm-prefix layout used by every caller.
	// The target directory does not exist yet, so there is no path to resolve.
	const packageDirectory = weightsCachePackageDir(outRoot, locale)

	// The manifest's `files` field may contain concrete siblings and pattern entries.
	// Globs do not identify a file to link, so the cache receives only concrete siblings.
	const declared = (manifest.files ?? []).filter(
		(entry) => !entry.startsWith("!") && !entry.includes("*") && entry !== "README.md"
	)

	const missing: string[] = []

	if (!values["dry-run"]) {
		await makeDirectories(packageDirectory)
		await createSymbolicLink(manifestPath, packageDirectory("package.json"))
	}

	for (const name of declared) {
		const source = locale === BASE_LOCALE && name === "model.onnx" ? modelPath : dataRootPath("weights", locale, name)

		if (!(await pathExists(source))) {
			missing.push(name)

			continue
		}

		linked += 1

		if (!values["dry-run"]) {
			await createSymbolicLink(source, packageDirectory(name))
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
