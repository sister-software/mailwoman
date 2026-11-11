/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The serial-dynamic-imports rule: consecutive independent `await import()` declarations load one at a time.
 *
 *   Each `await import()` waits for its module before the next one starts loading. Declarations in a row whose
 *   specifiers are string literals cannot depend on each other, so they can load together. The fix rewrites the run as
 *   one `allKeyed` call that keeps every binding pattern:
 *
 *   ```ts
 *   const { a } = await import("x")
 *   const { b } = await import("y")
 *   // becomes
 *   const { x: { a }, y: { b } } = await allKeyed({ x: import("x"), y: import("y") })
 *   ```
 *
 *   The rule doesn't report a side-effect `await import()` with no binding, because the order modules evaluate in
 *   may matter to it. A run stops at a comment between declarations, so the fix never deletes one.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { CreateRule, ESTree, Fix, Fixer } from "@oxlint/plugins"

/**
 * One declaration that awaits one module.
 */
interface LoneImport {
	statement: ESTree.VariableDeclaration
	kind: "const" | "let"
	/**
	 * The declaration's binding pattern, as written.
	 */
	pattern: string
	specifier: string
}

function loneImport(statement: ESTree.Node, text: string): LoneImport | null {
	if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return null

	if (statement.kind !== "const" && statement.kind !== "let") return null

	const [declarator] = statement.declarations
	const init = declarator?.init

	if (!declarator || !init || init.type !== "AwaitExpression" || init.argument.type !== "ImportExpression") return null

	const source = init.argument.source

	if (source.type !== "Literal" || typeof source.value !== "string" || init.argument.options) return null

	// A typed declaration states its type on the binding.
	// The keyed form has no place for that type.
	if ("typeAnnotation" in declarator.id && declarator.id.typeAnnotation) return null

	return {
		statement,
		kind: statement.kind,
		pattern: text.slice(declarator.id.range[0], declarator.id.range[1]),
		specifier: source.value,
	}
}

/**
 * The runs of two or more consecutive lone imports in `statements` with no comment between them.
 */
function importRuns(statements: readonly ESTree.Node[], text: string): LoneImport[][] {
	const runs: LoneImport[][] = []
	let run: LoneImport[] = []

	const close = (): void => {
		if (run.length > 1) {
			runs.push(run)
		}

		run = []
	}

	for (const statement of statements) {
		const lone = loneImport(statement, text)
		const previous = run.at(-1)

		if (!lone) {
			close()

			continue
		}

		if (previous && /\/\/|\/\*/u.test(text.slice(previous.statement.range[1], statement.range[0]))) {
			close()
		}

		run.push(lone)
	}

	close()

	return runs
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

/**
 * A key for a module in the keyed form: the specifier's last segment in camel case,
 * made unique within the run.
 */
export function keyFor(specifier: string, taken: Set<string>): string {
	// A `#` subpath import (`#resolver-backend`) or a `node:` builtin keys by the name after its prefix.
	const segment = (specifier.split("/").at(-1) ?? specifier)
		.replace(/^(?:#|node:)/u, "")
		.replace(/\.[cm]?[jt]sx?$/u, "")

	const camel = segment.replaceAll(/[-_.]+([A-Za-z0-9])/gu, (_match, letter: string) => letter.toUpperCase())
	const cleaned = camel.replaceAll(/[^\w$]/gu, "")
	const base = IDENTIFIER.test(cleaned) ? cleaned : `module${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`
	let key = base

	for (let suffix = 2; taken.has(key); suffix++) {
		key = `${base}${suffix}`
	}

	taken.add(key)

	return key
}

/**
 * The specifier this file imports `allKeyed` by: core's own `#promises` alias inside
 * `packages/core`, and the public subpath everywhere else.
 */
function allKeyedSpecifier(filename: string): string {
	return /(?:^|\/)packages\/core\//u.test(filename) ? "#promises" : "@mailwoman/core/promises"
}

function importsAllKeyed(program: ESTree.Program): boolean {
	return program.body.some(
		(statement) =>
			statement.type === "ImportDeclaration" &&
			statement.specifiers.some((specifier) => specifier.local.name === "allKeyed")
	)
}

/**
 * The edit that imports `allKeyed` into the file.
 *
 * It joins an existing value import of the same specifier, so the file keeps one import per module.
 * Otherwise it adds a declaration after the last import, or below the leading
 * header comment of a file that has none.
 */
function allKeyedImportFix(fixer: Fixer, program: ESTree.Program, text: string, filename: string): Fix {
	const specifier = allKeyedSpecifier(filename)
	const imports = program.body.filter((statement) => statement.type === "ImportDeclaration")

	const sameModule = imports.find(
		(statement) =>
			statement.source.value === specifier &&
			statement.importKind !== "type" &&
			statement.specifiers.length > 0 &&
			statement.specifiers.every((named) => named.type === "ImportSpecifier")
	)

	const lastNamed = sameModule?.specifiers.at(-1)

	if (lastNamed) return fixer.insertTextAfter(lastNamed, ", allKeyed")

	const declaration = `import { allKeyed } from ${stringifyJSON(specifier)}`
	const lastImport = imports.at(-1)

	if (lastImport) return fixer.insertTextAfter(lastImport, `\n${declaration}`)

	const header = /^\s*\/\*[\s\S]*?\*\/\n/u.exec(text)

	return fixer.insertTextAfterRange([0, header ? header[0].length : 0], `\n${declaration}\n`)
}

/**
 * Registered as `mailwoman/no-serial-dynamic-imports` by `oxlint.plugin.ts`.
 */
export const serialImportsRule: CreateRule = {
	meta: {
		type: "suggestion",
		docs: {
			description: "Load consecutive independent `await import()` declarations together with `allKeyed`.",
			recommended: true,
		},
		fixable: "code",
		schema: [],
		messages: {
			serial:
				"These {{count}} `await import()` declarations load one after another, and none depends on another. " +
				"Load them together with `allKeyed` from `@mailwoman/core/promises`.",
		},
	},
	create(context) {
		const text = context.sourceCode.text
		const runs: LoneImport[][] = []
		let program: ESTree.Program | null = null

		const collect = (statements: readonly ESTree.Node[]): void => {
			runs.push(...importRuns(statements, text))
		}

		return {
			Program(node) {
				program = node
				collect(node.body)
			},
			BlockStatement(node) {
				collect(node.body)
			},
			SwitchCase(node) {
				collect(node.consequent)
			},
			"Program:exit"() {
				let addImport = program !== null && !importsAllKeyed(program)

				for (const run of runs) {
					const taken = new Set<string>()
					const entries = run.map((lone) => ({ ...lone, key: keyFor(lone.specifier, taken) }))
					const kind = entries.some((entry) => entry.kind === "let") ? "let" : "const"
					const bindings = entries.map((entry) => `${entry.key}: ${entry.pattern}`).join(", ")
					const loads = entries.map((entry) => `${entry.key}: import(${stringifyJSON(entry.specifier)})`).join(", ")
					const first = run[0]!
					const last = run.at(-1)!
					const withImport = addImport ? program : null

					addImport = false

					context.report({
						node: run[1]!.statement,
						messageId: "serial",
						data: { count: String(run.length) },
						fix: (fixer) => {
							const replacement = `${kind} { ${bindings} } = await allKeyed({ ${loads} })`
							const edits = [fixer.replaceTextRange([first.statement.range[0], last.statement.range[1]], replacement)]

							if (withImport) {
								edits.push(allKeyedImportFix(fixer, withImport, text, context.filename))
							}

							return edits
						},
					})
				}
			},
		}
	},
}
