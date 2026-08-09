#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"

import { parseJSONStrict } from "@mailwoman/core/objects"
import Pastel from "pastel"

const packageJSONPath = findPackageJSON(import.meta.url)

if (!packageJSONPath) {
	throw new Error("Could not find package.json for mailwoman/cli")
}

const packageJSON = parseJSONStrict<{ version: string }>(readFileSync(packageJSONPath, "utf8"))

const app = new Pastel({
	importMeta: import.meta,
	description: "A calibrated, retrieval-augmented postal-address parser — CLI + library.",
	name: "Mailwoman CLI",
	version: packageJSON.version,
})

await app.run()
