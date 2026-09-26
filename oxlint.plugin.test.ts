/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
 * A `for` header whose `from` is the `<base>.length - <n>` initializer.
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
 * `base[index]`, whose `property` carries its `type` because the rule reads it.
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

function constantIndexRead(base: string): TestNode {
	return {
		type: "MemberExpression",
		computed: true,
		range: [0, 0],
		object: { type: "Identifier", name: base },
		property: { type: "Literal", value: 0 },
	}
}

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
	// The home is `shuffleWith`, not `SeededRandom.shuffle`, because the class seeds
	// mulberry32 internally and three copies pin their own stream.
	expect(destructured[0]).toContain("shuffleWith")
	expect(reportsFor("prefer-home", forLoop({ body: temporarySwap("rows") }))).toHaveLength(1)
})

test("prefer-home stays silent on loops that are not a shuffle", () => {
	const scan: TestNode = {
		type: "BlockStatement",
		range: [0, 0],
		body: [{ type: "ExpressionStatement", expression: { type: "CallExpression", callee: { name: "visit" } } }],
	}

	expect(reportsFor("prefer-home", forLoop({ body: scan }))).toEqual([])
	expect(reportsFor("prefer-home", forLoop({ update: "++", body: destructuredSwap("xs") }))).toEqual([])
	expect(reportsFor("prefer-home", forLoop({ until: -1, body: destructuredSwap("xs") }))).toEqual([])

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

	// Heapsort's extraction phase, which satisfies every clause except that one index is the literal 0.
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

function typeReference(name: string, ...parameters: TestNode[]): TestNode {
	const reference: TestNode = { type: "TSTypeReference", range: [0, 0], typeName: identifier(name) }

	if (parameters.length) {
		reference.typeArguments = { type: "TSTypeParameterInstantiation", range: [0, 0], params: parameters }
	}

	return reference
}

function awaitUsingProgram(initializer: TestNode, ...preamble: TestNode[]): TestNode {
	return {
		type: "Program",
		range: [0, 0],
		body: [
			...preamble,
			{
				type: "VariableDeclaration",
				kind: "await using",
				range: [0, 0],
				declarations: [{ type: "VariableDeclarator", range: [0, 0], id: identifier("db"), init: initializer }],
			},
		],
	}
}

function call(callee: TestNode, awaited: boolean): TestNode {
	const expression: TestNode = { type: "CallExpression", range: [0, 0], callee, arguments: [] }

	return awaited ? { type: "AwaitExpression", range: [0, 0], argument: expression } : expression
}

test("no-await-using-sync-disposable reports a construction, a static factory and a cross-package one", () => {
	const construction: TestNode = {
		type: "NewExpression",
		range: [0, 0],
		callee: identifier("DatabaseClient"),
		arguments: [],
	}

	const temp = call(
		{ type: "MemberExpression", range: [0, 0], object: identifier("DatabaseClient"), property: identifier("temp") },
		false
	)

	expect(reportsFor("no-await-using-sync-disposable", awaitUsingProgram(construction))).toHaveLength(1)
	expect(reportsFor("no-await-using-sync-disposable", awaitUsingProgram(temp))).toHaveLength(1)

	const messages = reportsFor("no-await-using-sync-disposable", awaitUsingProgram(call(identifier("openDuckDB"), true)))

	expect(messages).toHaveLength(1)
	expect(messages[0]).toContain("`using`")
})

test("no-await-using-sync-disposable reads a same-file helper's declared return type", () => {
	const helper: TestNode = {
		type: "FunctionDeclaration",
		range: [0, 0],
		id: identifier("fixtureDB"),
		returnType: {
			type: "TSTypeAnnotation",
			range: [0, 0],
			typeAnnotation: typeReference("Promise", typeReference("DatabaseClient", typeReference("WOFDatabase"))),
		},
	}

	const program = awaitUsingProgram(call(identifier("fixtureDB"), true), helper)

	expect(reportsFor("no-await-using-sync-disposable", program)).toHaveLength(1)
})

test("no-await-using-sync-disposable leaves an asynchronously-disposed resource alone", () => {
	const scratch = awaitUsingProgram(call(identifier("temporaryDirectory"), true))

	expect(reportsFor("no-await-using-sync-disposable", scratch)).toEqual([])

	const stack: TestNode = {
		type: "NewExpression",
		range: [0, 0],
		callee: identifier("AsyncDisposableStack"),
		arguments: [],
	}

	expect(reportsFor("no-await-using-sync-disposable", awaitUsingProgram(stack))).toEqual([])
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
