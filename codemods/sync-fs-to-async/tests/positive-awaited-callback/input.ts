import { existsSync, readFileSync } from "@mailwoman/platform/fs"
import { beforeAll, describe, it } from "vitest"

describe("suite", () => {
	// The runner awaits a hook's callback, so marking it async is free.
	beforeAll(() => {
		existsSync("a")
	})

	// Two rewrites in one callback: the `async` keyword is inserted once.
	it("reads twice", () => {
		readFileSync("a", "utf8")
		readFileSync("b", "utf8")
	})

	// The chained form hosts its callback under `it` all the same.
	it.each([1])("each form", () => {
		existsSync("c")
	})

	// A callback the runner does NOT await stays as it is.
	it("filters", () => {
		const kept = ["a", "b"].filter((path) => existsSync(path))

		void kept
	})
})
