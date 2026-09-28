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
 * and the only one that carries a model.
 */
const BASE_LOCALE = "en-us"

/**
 * Locales staged by default: the base plus every overlay the gauntlet's board can route to,
 * which is the set whose absence the harness warns about; `routing.ts` is the authority on routing.
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
	// The npm-prefix layout has one home, and this is a caller of it: the directory does not exist yet,
	// so there is no path to resolve and spelling it out would put a second copy beside the first.
	const packageDirectory = weightsCachePackageDir(outRoot, locale)

	// The manifest's `files` mixes concrete data siblings with globs and negations,
	// and a glob has no file to link, so only the concrete siblings belong in a cache.
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
