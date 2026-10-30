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
import { parsePythonYAML } from "@mailwoman/corpus/training/config/python-yaml"
import { CONFIG_SECTION } from "@mailwoman/corpus/training/config/schema"

import { trainingConfigPath } from "../config.ts"
import { unknownConfigKeys } from "./config-keys.ts"

const directory = trainingConfigPath()

// The committed configs, as the Python audit's `glob("*.yaml")` over the package directory read them.
const files = (await workingTreeFiles(["packages/corpus/data/training-configs/*.yaml"]))
	.map((path) => path.split("/").at(-1)!)
	.toSorted()

const junkByFile = new Map<string, string[]>()
const otherErrors = new Map<string, string>()

for (const name of files) {
	const path = `${directory}/${name}`
	const text = await readLocalTextFile(path)
	const junk = unknownConfigKeys(parsePythonYAML(text, path), CONFIG_SECTION)

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
