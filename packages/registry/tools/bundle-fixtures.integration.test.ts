/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bundles tiny consumers of each narrow import with esbuild and checks what each bundle retains.
 *
 *   A country-only consumer must hold no airport payload, a collision-only consumer no record or name, and no browser
 *   graph may reach a `node:` module. The checks read the emitted bundle for the base64 text of the excluded artifacts
 *   and for strings only a record pool holds, so they measure the emitted bytes rather than the import graph.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

import { artifactModulePath } from "./artifact-path.ts"

const registry = workspacePath("registry")

async function bundle(source: string): Promise<string> {
	const result = await build({
		stdin: { contents: source, resolveDir: registry, loader: "ts" },
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		conditions: ["browser", "default"],
		treeShaking: true,
		minify: false,
		logLevel: "silent",
	})

	return result.outputFiles[0]!.text
}

/**
 * The first 64 characters of an artifact module's base64 text, enough to identify the artifact in a bundle.
 */
async function signature(name: string): Promise<string> {
	const module = await readLocalTextFile(
		workspacePath("registry", "lib", "artifacts", `${artifactModulePath(name)}.ts`)
	)

	const match = /"([A-Za-z0-9+/=]{64})/.exec(module)

	if (!match) throw new Error(`${name}: no base64 text`)

	return match[1]!
}

describe("bundle fixtures", () => {
	it("a country alpha-2 predicate retains its bitset and no airport, name or record payload", async () => {
		const text = await bundle(
			`import { isCountryCodeAlpha2 } from "./out/iso3166/alpha2.js"; console.log(isCountryCodeAlpha2("GB"))`
		)

		expect(text).toContain(await signature("iso3166-1-alpha2-membership"))
		expect(text).not.toContain(await signature("iata-airport-records"))
		expect(text).not.toContain(await signature("iso3166-1-records"))
		expect(text).not.toContain(await signature("country-airport-collision"))
		expect(text).not.toContain("node:")
		expect(text.length).toBeLessThan(20_000)
	})

	it("a collision predicate retains the intersection bitset and no record payload", async () => {
		const text = await bundle(
			`import { isCountryAirportCollision } from "./out/overlap/country-airport.js"; console.log(isCountryAirportCollision("AUS"))`
		)

		expect(text).toContain(await signature("country-airport-collision"))
		expect(text).not.toContain(await signature("iata-airport-records"))
		expect(text).not.toContain(await signature("iso3166-1-records"))
		expect(text).not.toContain("Austin")
		expect(text).not.toContain("node:")
	})

	it("the interpretation API retains the record artifacts", async () => {
		const text = await bundle(
			`import { interpretCountryOrAirportCode } from "./out/overlap/country-airport.js"; console.log(interpretCountryOrAirportCode("AUS"))`
		)

		expect(text).toContain(await signature("iata-airport-records"))
		expect(text).toContain(await signature("iso3166-1-records"))
	})

	it("the wasm adapter retains the three membership artifacts and no record", async () => {
		const text = await bundle(`import { createRegistry } from "./out/wasm.js"; console.log(createRegistry)`)

		expect(text).toContain(await signature("country-airport-collision"))
		expect(text).not.toContain(await signature("iata-airport-records"))
		expect(text).not.toContain("node:")
	})

	it("a type-only import emits no data", async () => {
		const text = await bundle(
			`import type { ISO } from "./out/types.js"; const code = "GB" as ISO.CountryCode_3166_1_Alpha2; console.log(code)`
		)

		expect(text).not.toContain("RGY1")
		expect(text.length).toBeLessThan(500)
	})
})
