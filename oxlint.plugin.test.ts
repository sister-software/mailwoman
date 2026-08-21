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
