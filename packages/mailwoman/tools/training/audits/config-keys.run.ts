/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lists every key a strict config load would refuse, across every committed training config (#1248).
 *
 *   It walks each YAML against the config sections and reports every unknown dotted key, where the strict loader
 *   stops at the first. It also loads each file and reports any other refusal separately, so the two failure
 *   classes stay apart.
 *
 *   Usage: node packages/mailwoman/tools/training/audits/config-keys.run.ts
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workingTreeFiles } from "@mailwoman/core/git"
import { readTrainingConfigText, typedTrainingConfig } from "@mailwoman/corpus/training/config/load"
import { parsePythonYAML, type PythonValue } from "@mailwoman/corpus/training/config/python-yaml"
import { CONFIG_SECTION, type ConfigSectionSpec } from "@mailwoman/corpus/training/config/schema"

import { trainingPackagePath } from "../sampler.ts"

function unknownKeys(node: PythonValue, section: ConfigSectionSpec, prefix: string, junk: string[]): void {
	if (!(node instanceof Map)) return

	for (const [key, value] of node) {
		const dotted = prefix ? `${prefix}.${String(key)}` : String(key)
		const field = section.fields[String(key)]

		if (!field) {
			junk.push(dotted)

			continue
		}

		if (field.section) {
			unknownKeys(value, field.section, dotted, junk)
		}
	}
}

const directory = trainingPackagePath("configs")

// The committed configs, as the Python audit's `glob("*.yaml")` over the package directory read them.
const files = (await workingTreeFiles(["corpus-python/src/mailwoman_train/configs/*.yaml"]))
	.map((path) => path.split("/").at(-1)!)
	.toSorted()

const junkByFile = new Map<string, string[]>()
const otherErrors = new Map<string, string>()

for (const name of files) {
	const path = `${directory}/${name}`
	const text = await readLocalTextFile(path)
	const junk: string[] = []

	unknownKeys(parsePythonYAML(text, path), CONFIG_SECTION, "", junk)

	if (junk.length) {
		junkByFile.set(name, junk)
	}

	try {
		typedTrainingConfig(readTrainingConfigText(text, path), path)
	} catch (error) {
		otherErrors.set(name, `${(error as Error).name}: ${(error as Error).message}`)
	}
}

console.log(`audited ${files.length} config files\n`)

if (junkByFile.size) {
	console.log("JUNK KEYS (unknown to the dataclass schema):")

	for (const [name, keys] of junkByFile) {
		for (const key of keys) {
			console.log(`  ${name}: ${key}`)
		}
	}
} else {
	console.log("JUNK KEYS: none — every key in every config resolves against the schema.")
}

console.log()

if (otherErrors.size) {
	console.log("OTHER LOAD ERRORS (not unknown-key):")

	for (const [name, message] of otherErrors) {
		console.log(`  ${name}: ${message}`)
	}
} else {
	console.log("OTHER LOAD ERRORS: none.")
}
