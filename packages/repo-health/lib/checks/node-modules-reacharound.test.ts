import { describe, expect, it } from "vitest"

import { findReachArounds } from "#checks/node-modules-reacharound"

describe("findReachArounds", () => {
	it.each([
		'runFile("./node_modules/.bin/tsc", args)',
		'const executable = "./node_modules/.bin/tsc"',
		"const executable = `node_modules/.bin/${name}`",
		"const candidates = [`${root}/node_modules/@mailwoman/neural-weights-en-us/${fileName}`]",
		'pathExists("./node_modules/example/data.json")',
		'resolvePath(root, "node_modules", "example", "data.json")',
		"const candidates = [`${root}\\\\node_modules\\\\example\\\\data.json`]",
	])("reports an install-path assumption in %s", (source) => {
		expect(findReachArounds(source, "example.ts")).toHaveLength(1)
	})

	it.each([
		'const exclude = ["**/node_modules/**", "!**/node_modules/**"]',
		'const directories = new Set(["node_modules", "out"])',
		'file.includes("/node_modules/")',
		'const segments = ["/out/", "/node_modules/"]',
		"// node node_modules/example/bin/command.js",
		'resolvePackagePathFrom(import.meta.url, "example", "data.json")',
	])("preserves exclusions, comments, and resolved paths in %s", (source) => {
		expect(findReachArounds(source, "example.ts")).toEqual([])
	})

	it("reports a template argument once with the containing call and its line", () => {
		const source = "\nresolvePath(root, `${root}/node_modules/example/data.json`)"

		expect(findReachArounds(source, "example.ts")).toEqual([{ line: 2, text: source.trim() }])
	})
})
