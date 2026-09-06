/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Unit tests for Mailwoman's repository-local oxlint rules.
 */

import { expect, test } from "vitest"

import plugin from "./oxlint.plugin.ts"

interface TestNode {
	type: string
	range: [number, number]
	[key: string]: unknown
}

function reportsFor(ruleName: string, node: TestNode): string[] {
	const messages: string[] = []
	const rule = plugin.rules[ruleName]!

	const listeners = rule.create({
		options: [],
		report(descriptor) {
			messages.push(descriptor.message)
		},
	})

	listeners[node.type]?.(node)

	return messages
}

function commentReports(value: string): string[] {
	const messages: string[] = []
	const rule = plugin.rules["require-disable-reason"]!
	const comment = { type: "Line", range: [0, value.length] as [number, number], value }

	const listeners = rule.create({
		options: [],
		sourceCode: { getAllComments: () => [comment] },
		report(descriptor) {
			messages.push(descriptor.message)
		},
	})

	listeners.Program?.({ type: "Program", range: [0, value.length] })

	return messages
}

function identifier(name: string): TestNode {
	return { type: "Identifier", name, range: [0, 0] }
}

function databaseCall(method: string, argument: TestNode): TestNode {
	return {
		type: "CallExpression",
		range: [0, 0],
		callee: {
			type: "MemberExpression",
			range: [0, 0],
			object: identifier("db"),
			property: identifier(method),
		},
		arguments: [argument],
	}
}

test("no-database-boundary-cast rejects never casts in typed query-builder calls", () => {
	const cast = {
		type: "TSAsExpression",
		range: [0, 0] as [number, number],
		expression: { type: "Literal", value: "poi", range: [0, 0] },
		typeAnnotation: { type: "TSNeverKeyword", range: [0, 0] },
	}

	const messages = reportsFor("no-database-boundary-cast", databaseCall("insertInto", cast))

	expect(messages).toHaveLength(1)
	expect(messages[0]).toContain("Give `DatabaseClient`/`Kysely` its real database schema type")
})

test("no-database-boundary-cast permits typed arguments and unrelated APIs", () => {
	const cast = {
		type: "TSAsExpression",
		range: [0, 0] as [number, number],
		expression: identifier("value"),
		typeAnnotation: { type: "TSNeverKeyword", range: [0, 0] },
	}

	expect(reportsFor("no-database-boundary-cast", databaseCall("insertInto", identifier("table")))).toEqual([])
	expect(reportsFor("no-database-boundary-cast", databaseCall("unrelatedMethod", cast))).toEqual([])
})

test("require-disable-reason requires an inline explanation", () => {
	expect(commentReports(" oxlint-disable-next-line complexity")).toHaveLength(1)
	expect(commentReports(" oxlint-disable-next-line complexity -- one-pass state machine")).toEqual([])
	expect(commentReports(" ordinary comment")).toEqual([])
})

function chainedCall(chain: string[], args: TestNode[] = []): TestNode {
	let object: TestNode = { type: "NewExpression", range: [0, 0] }

	for (const [index, method] of chain.entries()) {
		object = {
			type: "CallExpression",
			range: [0, 0],
			callee: { type: "MemberExpression", range: [0, 0], object, property: identifier(method) },
			arguments: index === chain.length - 1 ? args : [],
		}
	}

	return object
}

function numeric(value: number): TestNode {
	return { type: "Literal", value, range: [0, 0] }
}

test("prefer-home names isoDate for toISOString().slice(0, 10) and stays silent on other slices", () => {
	const messages = reportsFor("prefer-home", chainedCall(["toISOString", "slice"], [numeric(0), numeric(10)]))

	expect(messages).toHaveLength(1)
	expect(messages[0]).toContain("`isoDate` from `@mailwoman/core/utils`")
	expect(reportsFor("prefer-home", chainedCall(["toISOString", "slice"], [numeric(0), numeric(7)]))).toEqual([])
	expect(reportsFor("prefer-home", chainedCall(["trim", "slice"], [numeric(0), numeric(10)]))).toEqual([])
})

test("prefer-home matches the chain as a suffix of a longer call chain", () => {
	const messages = reportsFor("prefer-home", chainedCall(["valueOf", "toISOString", "replace"]))

	expect(messages).toHaveLength(1)
	expect(messages[0]).toContain("isoSeconds")
})

test("prefer-home names the home for a re-typed constant and ignores other numbers", () => {
	expect(reportsFor("prefer-home", numeric(6371))[0]).toContain("`@mailwoman/spatial`")
	expect(reportsFor("prefer-home", numeric(6_371_000))[0]).toContain("haversineKm")
	expect(reportsFor("prefer-home", numeric(0x6d_2b_79_f5))[0]).toContain("`mulberry32`")
	expect(reportsFor("prefer-home", numeric(1_013_904_223))[0]).toContain("`makeLcg`")
	expect(reportsFor("prefer-home", numeric(6372))).toEqual([])
	expect(reportsFor("prefer-home", { type: "Literal", value: "6371", range: [0, 0] })).toEqual([])
})

test("prefer-home names the git home for a shell-out string in a literal or a template", () => {
	expect(reportsFor("prefer-home", { type: "Literal", value: "rev-parse HEAD", range: [0, 0] })[0]).toContain(
		"`@mailwoman/core/git`"
	)

	const template = {
		type: "TemplateLiteral",
		range: [0, 0] as [number, number],
		quasis: [{ type: "TemplateElement", range: [0, 0], value: { cooked: "git status --porcelain" } }],
		expressions: [],
	}

	expect(reportsFor("prefer-home", template)).toHaveLength(1)
	expect(reportsFor("prefer-home", { type: "Literal", value: "git push", range: [0, 0] })).toEqual([])
})

function importNode(type: string, specifier: string): TestNode {
	const source = { type: "Literal", value: specifier, range: [0, 0] as [number, number] }

	return type === "TSImportType" ? { type, range: [0, 0], argument: source } : { type, range: [0, 0], source }
}

function viCall(method: string, specifier: string): TestNode {
	return {
		type: "CallExpression",
		range: [0, 0],
		callee: { type: "MemberExpression", object: { name: "vi" }, property: { name: method } },
		arguments: [{ type: "Literal", value: specifier, range: [0, 0] }],
	}
}

test("no-private-import-in-test reports a # specifier in every import position", () => {
	for (const type of ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]) {
		expect(reportsFor("no-private-import-in-test", importNode(type, "#env"))).toHaveLength(1)
	}

	expect(reportsFor("no-private-import-in-test", importNode("TSImportType", "#env"))).toHaveLength(1)
	expect(reportsFor("no-private-import-in-test", viCall("mock", "#env"))).toHaveLength(1)
	expect(reportsFor("no-private-import-in-test", viCall("importActual", "#env"))[0]).toMatch(/public exports/)
})

test("no-private-import-in-test leaves public, relative and unrelated specifiers alone", () => {
	expect(reportsFor("no-private-import-in-test", importNode("ImportDeclaration", "@mailwoman/core/env"))).toEqual([])
	expect(reportsFor("no-private-import-in-test", importNode("ImportDeclaration", "./fixtures.ts"))).toEqual([])
	expect(reportsFor("no-private-import-in-test", viCall("mock", "@mailwoman/bdc/env"))).toEqual([])
	expect(reportsFor("no-private-import-in-test", viCall("stubEnv", "#not-a-specifier"))).toEqual([])
})
