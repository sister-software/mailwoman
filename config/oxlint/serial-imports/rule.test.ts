/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { keyFor } from "./rule.ts"

describe("the keyed form's module keys", () => {
	it("keys a module by its last segment in camel case", () => {
		expect(keyFor("@mailwoman/core/data-root", new Set())).toBe("dataRoot")
		expect(keyFor("@mailwoman/resolver-wof-sqlite", new Set())).toBe("resolverWofSqlite")
	})

	it("keys a subpath import and a builtin by the name after the prefix", () => {
		expect(keyFor("#resolver-backend", new Set())).toBe("resolverBackend")
		expect(keyFor("#env", new Set())).toBe("env")
		expect(keyFor("node:fs/promises", new Set())).toBe("promises")
		expect(keyFor("node:path", new Set())).toBe("path")
	})

	it("gives a segment that cannot start an identifier a module prefix", () => {
		expect(keyFor("./3d-tiles.ts", new Set())).toBe("module3dTiles")
	})

	it("numbers a key another module in the run already took", () => {
		const taken = new Set<string>()

		expect(keyFor("@mailwoman/flood/sdk/verify", taken)).toBe("verify")
		expect(keyFor("@mailwoman/soil/sdk/verify", taken)).toBe("verify2")
	})
})
