#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import Pastel from "pastel"

// Read the real version from this package's package.json rather than hardcoding it (it drifted to
// 0.1.0 while the package shipped 4.x). `import.meta.url` points at the compiled out/cli.js, so
// `../package.json` resolves to the installed package root in every layout (dev, tarball, global).
const { version } = parseJSONStrict<{ version: string }>(
	readFileSync(new URL("../package.json", import.meta.url), "utf8")
)

const app = new Pastel({
	importMeta: import.meta,
	description: "A calibrated, retrieval-augmented postal-address parser — CLI + library.",
	name: "Mailwoman CLI",
	version,
})

await app.run()
