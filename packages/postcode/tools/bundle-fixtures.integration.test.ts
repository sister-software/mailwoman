// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Bundles tiny consumers with esbuild and checks which artifacts each bundle retains.
 *
 *   The `postcode_legacy` and `postal` families have a public module each, so a bundle
 *   that imports one holds that family's artifact and no byte of the other's.
 *   The postal artifact is a 3.7 MB hexadecimal module, and a consumer of `knownFormats` mustn't load it.
 *
 *   The checks read the emitted bundle for the full hexadecimal text of each artifact,
 *   and the bundle's input list for the generated modules it evaluates.
 *   The test reads `out/`, so compile first.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const postcode = workspacePath("postcode").toString()

interface Bundled {
	text: string
	inputs: string[]
}

async function bundle(source: string): Promise<Bundled> {
	const result = await build({
		stdin: { contents: source, resolveDir: postcode, loader: "ts" },
		bundle: true,
		write: false,
		metafile: true,
		format: "esm",
		platform: "browser",
		conditions: ["browser", "default"],
		treeShaking: true,
		minify: false,
		logLevel: "silent",
		outdir: "out-bundle",
		loader: { ".wasm": "file" },
	})

	return {
		text: result.outputFiles.map((file) => file.text).join("\n"),
		inputs: Object.keys(result.metafile.inputs),
	}
}

/**
 * The hexadecimal text of a generated artifact module.
 */
async function payload(family: string): Promise<string> {
	const module = await readLocalTextFile(
		workspacePath("postcode", "lib", "recognizer", "artifacts", `${family}.generated.ts`)
	)

	const match = /"([0-9a-f]{200,})"/u.exec(module)

	if (!match) throw new Error(`${family}: no hexadecimal text`)

	return match[1]!
}

describe("bundle fixtures of the postcode families", () => {
	it("a consumer of the legacy family retains its artifact and no byte of the postal artifact", async () => {
		const { text, inputs } = await bundle(
			`import { postcodeLegacy } from "./out/recognizer/legacy.js"; console.log(postcodeLegacy.id)`
		)

		const legacy = await payload("postcode_legacy")
		const postal = await payload("postal")

		expect(text).toContain(legacy)
		expect(text).not.toContain(postal)
		expect(text).not.toContain(postal.slice(0, 4096))
		// The bundle holds the legacy artifact and the family's few lines of code.
		expect(text.length).toBeLessThan(legacy.length * 1.5)
		// The postal generated modules are absent from the module graph, so Node evaluates none of them either.
		expect(inputs.filter((input) => input.includes("postal"))).toEqual([])
	})

	it("a consumer of the postal family retains its artifact and no byte of the legacy artifact", async () => {
		const { text, inputs } = await bundle(
			`import { postal, acceptingCountries } from "./out/recognizer/postal.js"; console.log(postal.id, acceptingCountries)`
		)

		const legacy = await payload("postcode_legacy")
		const postal = await payload("postal")

		expect(text).toContain(postal)
		expect(text).not.toContain(legacy)
		expect(inputs.filter((input) => input.includes("legacy"))).toEqual([])
	})

	it("a consumer of both families retains both artifacts", async () => {
		const { text } = await bundle(
			`import { postcodeLegacy } from "./out/recognizer/legacy.js"; import { postal } from "./out/recognizer/postal.js"; console.log(postcodeLegacy.id, postal.id)`
		)

		expect(text).toContain(await payload("postcode_legacy"))
		expect(text).toContain(await payload("postal"))
	})
})
