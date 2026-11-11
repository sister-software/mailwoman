/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reports an update of a state column that does not compare the state it moves from.
 *
 *   A column whose name ends in `_state` stores a state machine's state, such as the license ledger's
 *   `license_state` and `email_state`. A step is decided from the state its caller read, so its write applies only
 *   while the row still holds that state. Another writer's step then fails as a conflict and is decided again, where a
 *   plain update would overwrite it.
 *
 *   The check reads two shapes. A Kysely chain `updateTable(…).set({…})` must also call
 *   `.where("<column>_state", "=", …)`.
 *   An SQL string `UPDATE … SET <column>_state = …` must test a `_state` column in its `WHERE` clause. A write that
 *   moves several state columns together compares one of them, as `setLicenseState` compares `license_state` while it
 *   records `payment_state`. Test sources are skipped because they plant fixture rows.
 *
 *   The check reads syntax. It misses a set object held in a variable, and an SQL statement assembled from pieces.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { isTestSource } from "#repo-health/ci/runtime-reads"

const STATE_COLUMN = /^[a-z][a-z0-9_]*_state$/u

const SOURCE_FILE = /\.tsx?$/u

const SQL_UPDATE = /\bUPDATE\s+\w+\s+SET\s+([\s\S]*?)(?:\bWHERE\b([\s\S]*))?$/iu

const SQL_ASSIGNED_STATE = /\b([a-z][a-z0-9_]*_state)\s*=/giu

/**
 * One write of a state column that does not compare a state.
 */
export interface UncomparedStateWrite {
	line: number
	columns: string[]
}

function propertyName(node: ts.PropertyName): string | null {
	return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null
}

/**
 * The `_state` columns a `.set(…)` argument assigns, including those inside a conditional spread.
 */
function assignedStateColumns(argument: ts.Expression): string[] {
	const columns: string[] = []

	const visit = (node: ts.Node): void => {
		if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name) {
			const name = propertyName(node.name)

			if (name && STATE_COLUMN.test(name)) {
				columns.push(name)
			}
		}

		node.forEachChild(visit)
	}

	visit(argument)

	return columns
}

/**
 * The method calls of a chain, from its first call outward: `a.updateTable(x).set(y).where(z)`.
 */
function chainOf(call: ts.CallExpression): ts.CallExpression[] {
	let head: ts.CallExpression = call

	while (ts.isPropertyAccessExpression(head.expression) && ts.isCallExpression(head.expression.expression)) {
		head = head.expression.expression
	}

	const chain: ts.CallExpression[] = [head]
	let current: ts.Node = head

	while (
		ts.isPropertyAccessExpression(current.parent) &&
		current.parent.expression === current &&
		ts.isCallExpression(current.parent.parent)
	) {
		current = current.parent.parent
		chain.push(current as ts.CallExpression)
	}

	return chain
}

function methodName(call: ts.CallExpression): string | null {
	return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null
}

function comparesState(call: ts.CallExpression): boolean {
	const [column, operator] = call.arguments

	return (
		methodName(call) === "where" &&
		!!column &&
		ts.isStringLiteralLike(column) &&
		STATE_COLUMN.test(column.text.slice(column.text.lastIndexOf(".") + 1)) &&
		!!operator &&
		ts.isStringLiteralLike(operator) &&
		operator.text === "="
	)
}

/**
 * The template's text with each substitution replaced by a placeholder, or a plain string's text.
 */
function sqlShapeOf(node: ts.StringLiteralLike | ts.TemplateExpression): string {
	if (!ts.isTemplateExpression(node)) return node.text

	return node.head.text + node.templateSpans.map((span) => `?${span.literal.text}`).join("")
}

/**
 * Every write of a `_state` column in one source that does not compare a `_state` column.
 */
export function uncomparedStateWrites(source: ts.SourceFile): UncomparedStateWrite[] {
	const found: UncomparedStateWrite[] = []
	const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && methodName(node) === "set" && node.arguments[0]) {
			const columns = assignedStateColumns(node.arguments[0])
			const chain = chainOf(node)

			if (columns.length && chain.some((call) => methodName(call) === "updateTable") && !chain.some(comparesState)) {
				found.push({ line: lineOf(node), columns })
			}
		}

		if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
			const match = SQL_UPDATE.exec(sqlShapeOf(node))

			if (match) {
				const columns = Array.from(match[1]!.matchAll(SQL_ASSIGNED_STATE), (assigned) => assigned[1]!)
				const compared = match[2] ? Array.from(match[2].matchAll(SQL_ASSIGNED_STATE)).length > 0 : false

				if (columns.length && !compared) {
					found.push({ line: lineOf(node), columns })
				}
			}
		}

		node.forEachChild(visit)
	}

	source.forEachChild(visit)

	return found
}

/**
 * The `state-column-writes` check.
 */
export const stateColumnWritesCheck: RepoCheck = {
	id: "state-column-writes",
	description: "Every update of a `_state` column applies only while the row holds the state its caller read.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const file of context.trackedFiles) {
			if (!SOURCE_FILE.test(file) || file.endsWith(".d.ts") || isTestSource(file)) continue

			const text = await readLocalTextFile(resolvePath(context.repoRoot, file))

			// Most sources hold no state column, so a substring search skips them before parsing.
			if (!text.includes("_state")) continue

			const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

			for (const write of uncomparedStateWrites(source)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`${file}:${write.line} writes ${write.columns.join(", ")} without comparing the state it moves from. ` +
						"Add the compare to the write, or apply the step through applyStep from @mailwoman/core/state-machine.",
					file,
					line: write.line,
					details: null,
				})
			}
		}

		return diagnostics
	},
}
