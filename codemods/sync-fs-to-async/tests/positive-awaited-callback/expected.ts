import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"

import { existsSync } from "node:fs"
import { beforeAll, describe, it } from "vitest"

describe("suite", () => {
	// The runner awaits a hook's callback, so marking it async is free.
	beforeAll(async () => {
		await pathExists("a")
	})

	// Two rewrites in one callback: the `async` keyword is inserted once.
	it("reads twice", async () => {
		await readLocalTextFile("a")
		await readLocalTextFile("b")
	})

	// The chained form hosts its callback under `it` all the same.
	it.each([1])("each form", async () => {
		await pathExists("c")
	})

	// A callback the runner does NOT await stays as it is.
	it("filters", () => {
		const kept = ["a", "b"].filter((path) => existsSync(path))

		void kept
	})
})
