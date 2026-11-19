// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Bundles tiny consumers with esbuild and checks which artifacts and
 *   which engine binary each bundle retains.
 *
 *   A bundle that imports one family holds that family's artifact and neither
 *   the other family's artifact nor the engine.
 *   A bundle that creates a recognizer holds the engine and only the artifacts it imports.
 *
 *   The `workerd` entry holds no embedded binary, because it imports the `.wasm` file.
 *   The checks read the emitted bundle for the full base64 text of each artifact,
 *   so they measure emitted bytes and not the import graph.
 *   The test reads `out/`, so compile first.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const recognize = workspacePath("recognizer").toString()

async function bundle(source: string, conditions: string[] = ["browser", "default"]): Promise<string> {
	const result = await build({
		stdin: { contents: source, resolveDir: recognize, loader: "ts" },
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		conditions,
		treeShaking: true,
		minify: false,
		logLevel: "silent",
		outdir: "out-bundle",
		loader: { ".wasm": "file" },
	})

	return result.outputFiles.map((file) => file.text).join("\n")
}

/**
 * The hexadecimal text of a generated artifact module or the embedded engine.
 */
async function payload(file: string): Promise<string> {
	const module = await readLocalTextFile(workspacePath("recognizer", "lib", file))
	const match = /"([0-9a-f]{200,})"/u.exec(module)

	if (!match) throw new Error(`${file}: no hexadecimal text`)

	return match[1]!
}

describe("bundle fixtures", () => {
	it("a family module retains its own artifact, no other artifact and no engine", async () => {
		const text = await bundle(`import { coordinates } from "./out/coordinates.js"; console.log(coordinates.id)`)

		expect(text).toContain(await payload("artifacts/coordinates.generated.ts"))
		expect(text).not.toContain(await payload("artifacts/primitives.generated.ts"))
		expect(text).not.toContain(await payload("embedded.generated.ts"))
		expect(text).not.toContain("node:")
	})

	it("a recognizer over one family retains the engine and that family's artifact alone", async () => {
		const text = await bundle(
			`import { createRecognizer } from "./out/index.js"; import { primitives } from "./out/primitives.js"; console.log(createRecognizer([primitives]).recognize("a"))`
		)

		expect(text).toContain(await payload("embedded.generated.ts"))
		expect(text).toContain(await payload("artifacts/primitives.generated.ts"))
		expect(text).not.toContain(await payload("artifacts/coordinates.generated.ts"))
		expect(text).not.toContain("node:")
	})

	it("a recognizer over both families retains both artifacts", async () => {
		const text = await bundle(
			`import { createRecognizer } from "./out/index.js"; import { primitives } from "./out/primitives.js"; import { coordinates } from "./out/coordinates.js"; console.log(createRecognizer([primitives, coordinates]))`
		)

		expect(text).toContain(await payload("artifacts/primitives.generated.ts"))
		expect(text).toContain(await payload("artifacts/coordinates.generated.ts"))
	})

	it("the workerd entry imports the binary and embeds none", async () => {
		const text = await bundle(
			`import { createRecognizer } from "@mailwoman/recognizer"; import { coordinates } from "./out/coordinates.js"; console.log(createRecognizer([coordinates]))`,
			["workerd", "browser", "default"]
		)

		expect(text).not.toContain(await payload("embedded.generated.ts"))
		expect(text).toContain("recognize.wasm")
		expect(text).toContain(await payload("artifacts/coordinates.generated.ts"))
	})

	it("a type-only import emits no data", async () => {
		const text = await bundle(
			`import type { Validated } from "./out/types.js"; const value = 1 as unknown as Validated.Decimal; console.log(value)`
		)

		expect(text).not.toContain("RCA1")
		expect(text.length).toBeLessThan(500)
	})
})
