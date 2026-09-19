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

/**
 * A `for` header, by its three clauses. `from` is the `<base>.length - <n>` initializer, so a test can vary the descent
 * without restating the whole node.
 */
function forLoop(options: {
	from?: number
	until?: number
	test?: string
	update?: string
	body: TestNode
	base?: string
}): TestNode {
	const base = options.base ?? "xs"

	return {
		type: "ForStatement",
		range: [0, 0],
		init: {
			type: "VariableDeclaration",
			declarations: [
				{
					type: "VariableDeclarator",
					init: {
						type: "BinaryExpression",
						operator: "-",
						left: { type: "MemberExpression", object: { name: base }, property: { name: "length" } },
						right: { type: "Literal", value: options.from ?? 1 },
					},
				},
			],
		},
		test: {
			type: "BinaryExpression",
			operator: options.test ?? ">",
			left: { type: "Identifier", name: "i" },
			right: { type: "Literal", value: options.until ?? 0 },
		},
		update: { type: "UpdateExpression", operator: options.update ?? "--" },
		body: options.body,
	}
}

/**
 * `base[index]`. `property` carries its `type` because the rule reads it: a swap of two variable indices is a shuffle,
 * a swap where one index is a literal is heapsort's extraction phase.
 */
function indexRead(base: string, index: string): TestNode {
	return {
		type: "MemberExpression",
		computed: true,
		range: [0, 0],
		object: { type: "Identifier", name: base },
		property: { type: "Identifier", name: index },
	}
}

/**
 * `base[0]` — a constant index, which is what separates heapsort from a shuffle.
 */
function constantIndexRead(base: string): TestNode {
	return {
		type: "MemberExpression",
		computed: true,
		range: [0, 0],
		object: { type: "Identifier", name: base },
		property: { type: "Literal", value: 0 },
	}
}

/**
 * `[base[i], base[j]] = [base[j], base[i]]` — the destructured swap.
 */
function destructuredSwap(base: string): TestNode {
	return {
		type: "BlockStatement",
		range: [0, 0],
		body: [
			{
				type: "ExpressionStatement",
				expression: {
					type: "AssignmentExpression",
					left: { type: "ArrayPattern", elements: [indexRead(base, "i"), indexRead(base, "j")] },
					right: { type: "ArrayExpression", elements: [indexRead(base, "j"), indexRead(base, "i")] },
				},
			},
		],
	}
}

/**
 * `tmp = base[i]; base[i] = base[j]; base[j] = tmp` — two index writes to one base.
 */
function temporarySwap(base: string): TestNode {
	const write = (index: string): TestNode => ({
		type: "ExpressionStatement",
		range: [0, 0],
		expression: {
			type: "AssignmentExpression",
			left: indexRead(base, index),
			right: { type: "Identifier", name: "tmp" },
		},
	})

	return { type: "BlockStatement", range: [0, 0], body: [write("i"), write("j")] }
}

test("prefer-home names shuffleWith for a re-typed Fisher-Yates, destructured or with a temporary", () => {
	const destructured = reportsFor("prefer-home", forLoop({ body: destructuredSwap("xs") }))

	expect(destructured).toHaveLength(1)
	expect(destructured[0]).toContain("`@mailwoman/core/random`")
	// The home is `shuffleWith`, not `SeededRandom.shuffle`. Three of the four copies could not use the class: each pins
	// its own stream, and the class seeds mulberry32 internally. Naming it would send a reader to the one home that
	// cannot serve them.
	expect(destructured[0]).toContain("shuffleWith")
	expect(reportsFor("prefer-home", forLoop({ body: temporarySwap("rows") }))).toHaveLength(1)
})

test("prefer-home stays silent on loops that are not a shuffle", () => {
	// A backwards scan that swaps nothing.
	const scan: TestNode = {
		type: "BlockStatement",
		range: [0, 0],
		body: [{ type: "ExpressionStatement", expression: { type: "CallExpression", callee: { name: "visit" } } }],
	}

	expect(reportsFor("prefer-home", forLoop({ body: scan }))).toEqual([])
	// Ascending, so `sample`'s partial-Fisher-Yates and every forward loop are out of scope.
	expect(reportsFor("prefer-home", forLoop({ update: "++", body: destructuredSwap("xs") }))).toEqual([])
	// Runs to 0 rather than 1 — a full reverse walk rather than a shuffle's arithmetic.
	expect(reportsFor("prefer-home", forLoop({ until: -1, body: destructuredSwap("xs") }))).toEqual([])

	// Two different arrays, so nothing is swapped in place.
	const across: TestNode = {
		type: "BlockStatement",
		range: [0, 0],
		body: [
			{
				type: "ExpressionStatement",
				expression: {
					type: "AssignmentExpression",
					left: { type: "ArrayPattern", elements: [indexRead("xs", "i"), indexRead("ys", "j")] },
					right: { type: "ArrayExpression", elements: [indexRead("ys", "j"), indexRead("xs", "i")] },
				},
			},
		],
	}

	expect(reportsFor("prefer-home", forLoop({ body: across }))).toEqual([])

	// Heapsort's extraction phase: counts down from the last index, stops at 1, swaps two computed indices of one array.
	// It satisfies every clause except that one index is the literal 0 — a shuffle swaps the loop variable with a drawn
	// index, and neither is a constant.
	const heapsort: TestNode = {
		type: "BlockStatement",
		range: [0, 0],
		body: [
			{
				type: "ExpressionStatement",
				expression: {
					type: "AssignmentExpression",
					left: { type: "ArrayPattern", elements: [constantIndexRead("xs"), indexRead("xs", "end")] },
					right: { type: "ArrayExpression", elements: [indexRead("xs", "end"), constantIndexRead("xs")] },
				},
			},
		],
	}

	expect(reportsFor("prefer-home", forLoop({ body: heapsort }))).toEqual([])
})

test("prefer-home reads `i >= 1` as the same stopping point as `i > 0`", () => {
	const messages = reportsFor("prefer-home", forLoop({ test: ">=", until: 1, body: destructuredSwap("xs") }))

	expect(messages).toHaveLength(1)
	expect(messages[0]).toContain("shuffleWith")
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
