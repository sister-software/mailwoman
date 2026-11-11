/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks each `sideEffects` declaration against the module-scope statements of the workspace's sources.
 *
 *   A bundler that reads `sideEffects: false` drops a module whose exports go unused, and with it whatever the module
 *   runs when it is evaluated. A workspace that declares the field, as `false` or as a list, must therefore list every
 *   source module that runs an import-time effect: a statement at module scope, a side-effect import, a top-level
 *   `await`, a class static block, a listener registration, or an effect-interface call outside any function.
 *
 *   The check also reports a `/* @__PURE__ *\/` annotation on an effect-interface call, because a bundler deletes an
 *   annotated call whose result goes unused.
 *
 *   It reads syntax. An initializer that calls a repository function with an effect inside it passes unless the call is
 *   to an effect interface or registers a listener.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { tsconfigGlob } from "#repo-health/checks/manifest-targets"
import { isTestSource } from "#repo-health/ci/runtime-reads"
import { bindSourceScope, type FileScope } from "#repo-health/effects/resolve"

/**
 * The source roots a workspace keeps exported code under.
 */
const SOURCE_ROOT = /^(?:lib|sdk|tools|cli)\//u

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u

/**
 * Method names that register a callback at module scope, so the registration runs
 * when the module is evaluated.
 */
const LISTENER_METHODS = new Set(["addEventListener", "on", "once", "prependListener", "subscribe"])

/**
 * One import-time effect a module runs.
 */
export interface ImportTimeEffect {
	line: number
	what: string
}

const PURE_ANNOTATION = /\/\*\s*[@#]__PURE__\s*\*\//u

function isFunctionLike(node: ts.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	)
}

/**
 * Whether `call` is a call to an effect interface: a function in an effect module, a class constructor
 * that opens a file, a static effect method such as `JSONSpliterator.fromAsync`, or `fetch`.
 */
function callsEffect(scope: FileScope, call: ts.CallExpression | ts.NewExpression): boolean {
	const callee = call.expression

	if (ts.isIdentifier(callee)) {
		if (callee.text === "fetch" && !scope.bindings.has("fetch")) return true

		const kind = scope.bindings.get(callee.text)?.kind

		return kind === "effect" || kind === "constructor"
	}

	return (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		scope.bindings.get(callee.expression.text)?.kind === "static-class"
	)
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
	const callee = call.expression

	if (ts.isIdentifier(callee)) return callee.text

	if (ts.isPropertyAccessExpression(callee)) return callee.name.text

	return "a call"
}

/**
 * The longest statement text a diagnostic quotes, so one diagnostic stays on one terminal line.
 */
const SNIPPET_LENGTH = 80

/**
 * The text of a statement's first line, for a diagnostic.
 */
function statementSnippet(source: ts.SourceFile, node: ts.Node): string {
	const text = node.getText(source)
	const newline = text.indexOf("\n")
	const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim()

	return firstLine.length > SNIPPET_LENGTH ? `${firstLine.slice(0, SNIPPET_LENGTH - 1)}…` : firstLine
}

/**
 * Whether a statement is `if (import.meta.main) …`, which runs only
 * when node runs the module as its entry point.
 */
function guardsMainModule(statement: ts.IfStatement): boolean {
	const condition = statement.expression

	return (
		ts.isPropertyAccessExpression(condition) &&
		condition.name.text === "main" &&
		ts.isMetaProperty(condition.expression) &&
		condition.expression.keywordToken === ts.SyntaxKind.ImportKeyword
	)
}

/**
 * The identifiers of the variables, functions and classes the module declares at module scope.
 */
function moduleScopeNames(source: ts.SourceFile): Set<string> {
	const names = new Set<string>()

	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					names.add(declaration.name.text)
				}
			}
		} else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
			names.add(statement.name.text)
		}
	}

	return names
}

/**
 * Whether an expression statement assigns a property of an object the module itself
 * declares, such as `Context.displayName = "Context"`.
 * The write stays inside the module's own state.
 */
function assignsOwnState(statement: ts.ExpressionStatement, own: ReadonlySet<string>): boolean {
	const expression = statement.expression

	if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false

	let target: ts.Expression = expression.left

	while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
		target = target.expression
	}

	return expression.left !== target && ts.isIdentifier(target) && own.has(target.text)
}

/**
 * The import-time effects a module's own statements run.
 */
export function importTimeEffects(source: ts.SourceFile, file: string): ImportTimeEffect[] {
	const scope = bindSourceScope(source, file, null)
	const effects: ImportTimeEffect[] = []
	const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
	const add = (node: ts.Node, what: string) => effects.push({ line: lineOf(node), what })

	// Walks an expression that runs at module scope and stops at a function body.
	// A body runs only when called.
	const visit = (node: ts.Node): void => {
		if (isFunctionLike(node)) return

		if (ts.isAwaitExpression(node)) {
			add(node, `awaits at module scope: ${statementSnippet(source, node)}`)

			return
		}

		if (ts.isClassStaticBlockDeclaration(node)) {
			add(node, "runs a class static block")

			return
		}

		if (ts.isPropertyDeclaration(node) && !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return

		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			if (callsEffect(scope, node)) {
				add(node, `calls the effect interface ${calleeName(node)} at module scope`)
			} else if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				LISTENER_METHODS.has(node.expression.name.text)
			) {
				add(node, `registers a listener at module scope: ${statementSnippet(source, node)}`)
			}
		}

		ts.forEachChild(node, visit)
	}

	const own = moduleScopeNames(source)

	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (!statement.importClause) {
				add(statement, `imports ${statement.moduleSpecifier.getText(source)} for its effects`)
			}

			continue
		}

		if (ts.isExpressionStatement(statement)) {
			// A directive prologue such as "use client" runs no code.
			if (ts.isStringLiteral(statement.expression) || assignsOwnState(statement, own)) continue

			add(statement, `runs a statement at module scope: ${statementSnippet(source, statement)}`)

			continue
		}

		if (ts.isIfStatement(statement) && guardsMainModule(statement)) continue

		if (
			ts.isIfStatement(statement) ||
			ts.isIterationStatement(statement, false) ||
			ts.isTryStatement(statement) ||
			ts.isSwitchStatement(statement) ||
			ts.isThrowStatement(statement) ||
			ts.isBlock(statement) ||
			ts.isLabeledStatement(statement)
		) {
			add(statement, `runs a statement at module scope: ${statementSnippet(source, statement)}`)

			continue
		}

		visit(statement)
	}

	return effects
}

/**
 * Each `/* @__PURE__ *\/` annotation on a call to an effect interface.
 */
export function pureAnnotatedEffects(source: ts.SourceFile, file: string): ImportTimeEffect[] {
	const scope = bindSourceScope(source, file, null)
	const found: ImportTimeEffect[] = []
	const text = source.getFullText()

	const visit = (node: ts.Node): void => {
		if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && callsEffect(scope, node)) {
			// An annotation after `=` on the same line is the previous token's trailing comment,
			// so the call's own trivia, between its full start and its start, is where to look.
			const trivia = text.slice(node.getFullStart(), node.getStart(source))

			if (PURE_ANNOTATION.test(trivia)) {
				found.push({
					line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
					what: `annotates the effect-interface call ${calleeName(node)} as pure, so a bundler may delete it`,
				})
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return found
}

/**
 * The compiled path a source path emits to, relative to its workspace:
 * `lib/a.ts` to `out/a.js`, `tools/b.ts` to `out/tools/b.js`.
 */
function compiledPathOf(sourcePath: string): string {
	const withoutRoot = sourcePath.startsWith("lib/") ? sourcePath.slice(4) : sourcePath

	return `out/${withoutRoot.replace(/\.[cm]?[jt]sx?$/u, ".js")}`
}

/**
 * A workspace's `sideEffects` declaration as a test of whether it lists one module.
 *
 * `declared` is the manifest's field.
 * `relative` is the module's path relative to the workspace.
 *
 * An entry matches the module by its source path or by its `out/` path.
 *
 * A workspace that declares `true` or no field lists every module, and `false` lists none.
 */
export function sideEffectsListing(declared: boolean | readonly string[] | undefined): (relative: string) => boolean {
	if (declared === false) return () => false

	if (!Array.isArray(declared)) return () => true

	const patterns = declared.map((entry) => tsconfigGlob(entry))

	return (relative) => patterns.some((pattern) => pattern.test(relative) || pattern.test(compiledPathOf(relative)))
}

function diagnostic(message: string, file: string | null, line: number | null = null): Diagnostic {
	return { severity: DiagnosticSeverity.Error, message, file, line, details: null }
}

/**
 * The `side-effects` check.
 */
export const sideEffectsCheck: RepoCheck = {
	id: "side-effects",
	description:
		"A workspace that declares sideEffects lists every source module that runs an import-time effect, and no effect-interface call is annotated pure.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const directory of await readWorkspaceDirectories(context.repoRoot)) {
			const manifest = (await readPackageJSON(resolvePath(context.repoRoot, directory, "package.json"))) as {
				name?: string
				sideEffects?: boolean | readonly string[]
			}

			const declared = manifest.sideEffects

			const sources = context.trackedFiles.filter((file) => {
				if (!file.startsWith(`${directory}/`)) return false

				const relative = file.slice(directory.length + 1)

				return SOURCE_ROOT.test(relative) && SOURCE_FILE.test(relative) && !relative.endsWith(".d.ts")
			})

			const lists = sideEffectsListing(declared)
			const checksDeclaration = declared === false || Array.isArray(declared)

			for (const file of sources) {
				if (isTestSource(file)) continue

				const text = await readLocalTextFile(resolvePath(context.repoRoot, file))
				const relative = file.slice(directory.length + 1)
				const annotated = PURE_ANNOTATION.test(text)

				const audited = checksDeclaration && !lists(relative)

				// A file is parsed only when it holds a pure annotation or its import-time effects need listing.
				// The other sources of an undeclaring workspace are most of the tree.
				if (!annotated && !audited) continue

				const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

				if (annotated) {
					for (const found of pureAnnotatedEffects(source, file)) {
						diagnostics.push(diagnostic(`${file}:${found.line} ${found.what}`, file, found.line))
					}
				}

				if (!audited) continue

				const effects = importTimeEffects(source, file)

				if (!effects.length) continue

				const [first] = effects

				diagnostics.push(
					diagnostic(
						`${manifest.name ?? directory} declares sideEffects ${Array.isArray(declared) ? "as a list" : "false"}, ` +
							`and ${file}:${first!.line} ${first!.what}` +
							(effects.length > 1 ? ` (and ${effects.length - 1} more)` : "") +
							". List the module in sideEffects, or move the effect into a function its caller runs.",
						file,
						first!.line
					)
				)
			}
		}

		return diagnostics
	},
}
