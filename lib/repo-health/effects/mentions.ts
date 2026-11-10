/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The rooted paths a source builds, whether or not an effect interface in the same file receives them.
 */

import ts from "typescript"

import { PathRoot } from "#repo-health/effects/interfaces"
import {
	constantLiteral,
	type FileScope,
	type ImportedPaths,
	isImportMeta,
	joinTarget,
	literalText,
	type ResolvedTarget,
	resolveTarget,
	scopeOf,
} from "#repo-health/effects/resolve"

/**
 * The literal arguments of `args` up to the first argument that is not one.
 */
function literalPrefix(args: readonly ts.Expression[]): string[] {
	const prefix: string[] = []

	for (const arg of args) {
		const text = literalText(arg) ?? constantLiteral(arg, 0)

		if (text === null) break

		prefix.push(text)
	}

	return prefix
}

/**
 * The deepest rooted directory a path-building call is known to stay under when its later
 * arguments do not resolve, as `repoRootPath("packages", name)` stays under `packages`.
 *
 * `null` when the call builds no path or its root does not resolve.
 */
function partialTarget(scope: FileScope, call: ts.CallExpression): ResolvedTarget | null {
	const callee = call.expression

	if (!ts.isIdentifier(callee)) return null

	const binding = scope.bindings.get(callee.text)

	if (binding?.kind === "builder" && !binding.builder.rebases) {
		const segments = literalPrefix(call.arguments)

		if (!binding.builder.packageFirst) return { root: binding.builder.root, path: segments.join("/") }

		const [packageName, ...rest] = segments

		// A package path under a name the file computes may be any package in the repository.
		return packageName
			? { root: PathRoot.Package, path: [packageName, ...rest].join("/") }
			: { root: PathRoot.Repository, path: "" }
	}

	if (binding?.kind === "join") {
		const [first, ...rest] = call.arguments
		const base = first ? resolveTarget(scope, first) : null

		return base ? joinTarget(base, literalPrefix(rest)) : null
	}

	if (binding?.kind === "rooted" && binding.rooted.kind === "constant") {
		return joinTarget(binding.rooted.target, literalPrefix(call.arguments))
	}

	return null
}

/**
 * Whether `call` builds a path: a root builder, a `paths` export, `resolvePath`
 * or `join`, or a `PathBuilder` factory.
 */
function buildsPath(scope: FileScope, call: ts.CallExpression): boolean {
	const callee = call.expression

	if (ts.isCallExpression(callee)) return true

	if (ts.isPropertyAccessExpression(callee)) {
		return (
			callee.name.text === "from" &&
			ts.isIdentifier(callee.expression) &&
			scope.bindings.get(callee.expression.text)?.kind === "path-builder-class"
		)
	}

	const kind = ts.isIdentifier(callee) ? scope.bindings.get(callee.text)?.kind : null

	return kind === "builder" || kind === "join" || kind === "rooted" || kind === "path-builder-function"
}

/**
 * Whether `call` is a call to an effect interface: a function in an effect module, a class
 * constructor that opens a file, or a static effect method such as `JSONSpliterator.fromAsync`.
 */
function callsEffectInterface(scope: FileScope, call: ts.CallExpression | ts.NewExpression): boolean {
	const callee = call.expression

	if (ts.isIdentifier(callee)) {
		const kind = scope.bindings.get(callee.text)?.kind

		return kind === "effect" || kind === "constructor"
	}

	return (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		scope.bindings.get(callee.expression.text)?.kind === "static-class"
	)
}

function isModuleURL(node: ts.Node): node is ts.NewExpression {
	return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL"
}

/**
 * Every rooted path the source builds for code it calls, such as a test that hands `repoRootPath()` to
 * the function it tests, or a library function whose parameter defaults to the repository root.
 *
 * Paths built for an effect call count once.
 * A path built as an effect call's argument counts only through that call's edge.
 *
 * The edge records whether the call reads the path's content or only its metadata.
 *
 * An effect argument that does not resolve contributes the directory its literal segments reach.
 *
 * Each path is the outermost one an expression builds: `resolvePath(dir, "x.json")`
 * contributes `x.json` under `dir` and leaves `dir` out.
 * A path passed to a string function such as `relative` reads no file and is left out.
 *
 * Literal paths are left out too, because a literal that reaches no effect
 * interface is data rather than a location.
 */
export function extractPathMentions(
	source: ts.SourceFile,
	file: string,
	importedPaths: ImportedPaths | null = null
): ResolvedTarget[] {
	const scope = scopeOf(source, file, importedPaths)
	const found: ResolvedTarget[] = []

	const record = (target: ResolvedTarget | null): boolean => {
		if (!target || target.root === PathRoot.Literal) return false

		found.push(target)

		return true
	}

	const visit = (node: ts.Node): void => {
		// `relative(repoRootPath(), file)` computes a string from the path and reads no file.
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			scope.bindings.get(node.expression.text)?.kind === "path-string"
		) {
			return
		}

		if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && callsEffectInterface(scope, node)) {
			for (const arg of node.arguments ?? []) {
				if (!resolveTarget(scope, arg)) {
					visit(arg)
				}
			}

			return
		}

		if (ts.isPropertyAccessExpression(node) && (isImportMeta(node, "dirname") || isImportMeta(node, "filename"))) {
			record(resolveTarget(scope, node))

			return
		}

		if (isModuleURL(node) && record(resolveTarget(scope, node))) return

		if (
			ts.isCallExpression(node) &&
			buildsPath(scope, node) &&
			record(resolveTarget(scope, node) ?? partialTarget(scope, node))
		) {
			return
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return found
}
