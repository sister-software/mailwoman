/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0 legacy excision (spec 2026-07-12): statically extract the `assert(input, ...expected)`
 *   calls from the v1 parity suite (`mailwoman/test/*.test.ts`) so the hand-written inputs +
 *   expectations survive the parser they currently exercise. Literal-only conversion — an expected
 *   arg that isn't a plain JSON literal is recorded as its source text with `nonLiteral: true`.
 */

import ts from "typescript"

export interface ParityCase {
	/** Repo-relative source file the assertion came from. */
	file: string
	/** The address input under test. */
	input: string
	/** The hand-written expected classification records (JSON values), file order preserved. */
	expected: unknown[]
	/** Set when an expected arg wasn't a pure literal; that slot in `expected` holds source text. */
	nonLiteral?: boolean
}

function literalToJSON(node: ts.Expression): { ok: true; value: unknown } | { ok: false } {
	if (ts.isStringLiteralLike(node)) return { ok: true, value: node.text }
	if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) }
	if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true }
	if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false }
	if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null }

	if (ts.isArrayLiteralExpression(node)) {
		const out: unknown[] = []

		for (const element of node.elements) {
			const value = literalToJSON(element)

			if (!value.ok) return { ok: false }
			out.push(value.value)
		}

		return { ok: true, value: out }
	}

	if (ts.isObjectLiteralExpression(node)) {
		const out: Record<string, unknown> = {}

		for (const property of node.properties) {
			if (!ts.isPropertyAssignment(property)) return { ok: false }

			const name =
				ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined

			if (name === undefined) return { ok: false }

			const value = literalToJSON(property.initializer)

			if (!value.ok) return { ok: false }
			out[name] = value.value
		}

		return { ok: true, value: out }
	}

	return { ok: false }
}

/** Extract every top-level-or-nested `assert("input", ...records)` call from one source text. */
export function extractAssertCalls(sourceText: string, fileName: string): ParityCase[] {
	const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
	const cases: ParityCase[] = []

	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "assert" &&
			node.arguments.length > 0 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			const input = node.arguments[0].text
			const expected: unknown[] = []
			let nonLiteral = false

			for (const arg of node.arguments.slice(1)) {
				const value = literalToJSON(arg)

				if (value.ok) {
					expected.push(value.value)
				} else {
					nonLiteral = true
					expected.push(arg.getText(source))
				}
			}

			cases.push(nonLiteral ? { file: fileName, input, expected, nonLiteral } : { file: fileName, input, expected })
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return cases
}
