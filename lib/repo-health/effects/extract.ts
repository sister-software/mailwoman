/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One source file's effect edges: each call to an interface in {@linkcode EFFECT_MODULES}, the global `fetch`, and
 *   the path or command each call names. A path is resolved from literals, the root builders in
 *   {@linkcode PATH_BUILDER_MODULES}, `resolvePath` over resolvable parts, `import.meta.dirname`,
 *   `new URL(…, import.meta.url)` and the `const` or `using` binding a name refers to in its scope. Anything else is
 *   recorded as unresolved with its
 *   expression, so a caller sees the call site rather than a missing edge.
 */

import { dirname, join } from "path-ts"
import ts from "typescript"

import {
	EFFECT_MODULES,
	EffectKind,
	type EffectInterface,
	PATH_BUILDER_MODULES,
	type PathRootBuilder,
	PathRoot,
} from "#repo-health/effects/interfaces"

interface ResolvedTarget {
	root: PathRoot
	path: string
}

/**
 * One effect at one call site.
 *
 * `target` is `null` exactly when the path could not be resolved, and `unresolved` then holds
 * the argument's source text, truncated to {@linkcode UNRESOLVED_TEXT_LENGTH} characters.
 */
export interface EffectEdge {
	file: string
	line: number
	interface: string
	kind: EffectKind
	target: ResolvedTarget | null
	unresolved: string | null
	/**
	 * Why the path did not resolve, or `null` when it did.
	 *
	 * `parameter` is a parameter of the enclosing function.
	 * Only that function's callers can resolve it.
	 */
	unresolvedShape: UnresolvedShape | null
}

type UnresolvedShape = "parameter" | "identifier" | "property" | "call" | "template" | "other"

function unresolvedShapeOf(expression: ts.Expression): UnresolvedShape {
	if (ts.isIdentifier(expression)) return isEnclosingParameter(expression) ? "parameter" : "identifier"

	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return "property"

	if (ts.isCallExpression(expression)) return "call"

	if (ts.isTemplateExpression(expression)) return "template"

	return "other"
}

/**
 * Whether `identifier` names a parameter of a function that encloses it.
 *
 * The source must be parsed with parent nodes set.
 */
function isEnclosingParameter(identifier: ts.Identifier): boolean {
	for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
		if (ts.isFunctionLike(node)) {
			const named = node.parameters.some(
				(parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
			)

			if (named) return true
		}
	}

	return false
}

const UNRESOLVED_TEXT_LENGTH = 120

/**
 * The number of constants a path follows before it stops.
 *
 * The limit ends a cycle of constants that refer to each other.
 */
const CONSTANT_DEPTH = 4

/**
 * Modules whose `resolvePath` and `join` join segments as `path-ts` does.
 */
const PATH_JOIN_MODULES = new Set(["path-ts", "node:path", "path"])

/**
 * Modules whose `temporaryDirectory` answers a scratch directory owned by the run.
 */
const TEMPORARY_MODULES = new Set(["@mailwoman/core/fs/temporary", "#fs/temporary"])

type Binding =
	| { kind: "effect"; effect: EffectInterface }
	| { kind: "builder"; builder: PathRootBuilder }
	| { kind: "join" }
	| { kind: "path-builder-class" }
	| { kind: "path-builder-function" }
	| { kind: "temporary" }

interface FileScope {
	file: string
	source: ts.SourceFile
	bindings: Map<string, Binding>
}

function collectBindings(source: ts.SourceFile): Map<string, Binding> {
	const bindings = new Map<string, Binding>()

	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue

		const specifier = statement.moduleSpecifier.text
		const named = statement.importClause?.namedBindings

		if (!named || !ts.isNamedImports(named) || statement.importClause?.isTypeOnly) continue

		const effects = EFFECT_MODULES.get(specifier)
		const builders = PATH_BUILDER_MODULES.get(specifier)
		const joins = PATH_JOIN_MODULES.has(specifier)
		const pathTS = specifier === "path-ts"
		const temporary = TEMPORARY_MODULES.has(specifier)

		for (const element of named.elements) {
			if (element.isTypeOnly) continue

			const imported = (element.propertyName ?? element.name).text
			const local = element.name.text
			const effect = effects?.find((candidate) => candidate.name === imported)
			const builder = builders?.find((candidate) => candidate.name === imported)

			if (effect) {
				bindings.set(local, { kind: "effect", effect })
			} else if (builder) {
				bindings.set(local, { kind: "builder", builder })
			} else if (joins && (imported === "resolvePath" || imported === "join")) {
				bindings.set(local, { kind: "join" })
			} else if (pathTS && imported === "PathBuilder") {
				bindings.set(local, { kind: "path-builder-class" })
			} else if (pathTS && imported === "resolvePathBuilder") {
				bindings.set(local, { kind: "path-builder-function" })
			} else if (temporary && imported === "temporaryDirectory") {
				bindings.set(local, { kind: "temporary" })
			}
		}
	}

	return bindings
}

/**
 * The flags of a declaration list whose bindings are never reassigned: `const`, `using` and `await using`.
 */
const FIXED_BINDINGS = ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing

/**
 * The initializer of the fixed binding `identifier` refers to, with an `await` removed, or `null`
 * when the name is a parameter, a reassignable binding, or declared nowhere the use can see.
 *
 * The lookup walks outward from the use, block by block, so an inner declaration
 * shadows an outer one as JavaScript scopes it.
 * A parameter of an enclosing function stops the walk.
 * The source must be parsed with parent nodes set.
 */
function initializerOf(identifier: ts.Identifier): ts.Expression | null {
	const name = identifier.text

	for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
		const statements = ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) ? node.statements : null

		for (const statement of statements ?? []) {
			if (!ts.isVariableStatement(statement)) continue

			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue

				const initializer = declaration.initializer

				if (!(statement.declarationList.flags & FIXED_BINDINGS) || !initializer) return null

				return ts.isAwaitExpression(initializer) ? initializer.expression : initializer
			}
		}

		if (
			ts.isFunctionLike(node) &&
			node.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)
		) {
			return null
		}
	}

	return null
}

function literalText(expression: ts.Expression): string | null {
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text

	return null
}

function isImportMeta(expression: ts.Expression, property: string): boolean {
	return (
		ts.isPropertyAccessExpression(expression) &&
		expression.name.text === property &&
		ts.isMetaProperty(expression.expression) &&
		expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
	)
}

/**
 * The literal text of every argument, or `null` when one is not a literal.
 */
function literalSegments(args: readonly ts.Expression[], depth: number): string[] | null {
	const segments: string[] = []

	for (const arg of args) {
		const text = literalText(arg) ?? constantLiteral(arg, depth)

		if (text === null) return null

		segments.push(text)
	}

	return segments
}

function constantLiteral(expression: ts.Expression, depth: number): string | null {
	if (!ts.isIdentifier(expression) || depth >= CONSTANT_DEPTH) return null

	const initializer = initializerOf(expression)

	return initializer ? (literalText(initializer) ?? constantLiteral(initializer, depth + 1)) : null
}

/**
 * Whether `node` contains a call to `temporaryDirectory`, so its value is the
 * run's own scratch directory or a path under it.
 */
function containsScratchCall(scope: FileScope, node: ts.Node): boolean {
	if (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		scope.bindings.get(node.expression.text)?.kind === "temporary"
	) {
		return true
	}

	return ts.forEachChild(node, (child) => containsScratchCall(scope, child) || undefined) ?? false
}

/**
 * The expressions a `let` binding of `identifier` takes: its initializer and every plain
 * assignment to it in the block that declares it, or `[]` when no `let` declaration is in scope.
 */
function letValues(identifier: ts.Identifier): ts.Expression[] {
	const name = identifier.text

	for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
		if (!(ts.isBlock(node) || ts.isSourceFile(node))) continue

		const declared = node.statements.some(
			(statement) =>
				ts.isVariableStatement(statement) &&
				!(statement.declarationList.flags & FIXED_BINDINGS) &&
				statement.declarationList.declarations.some(
					(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
				)
		)

		if (!declared) continue

		const values: ts.Expression[] = []

		const visit = (child: ts.Node): void => {
			if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name) {
				if (child.initializer) {
					values.push(child.initializer)
				}
			} else if (
				ts.isBinaryExpression(child) &&
				child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(child.left) &&
				child.left.text === name
			) {
				values.push(child.right)
			}

			ts.forEachChild(child, visit)
		}

		visit(node)

		return values
	}

	return []
}

/**
 * Whether `identifier` holds a scratch value: a `const` whose initializer contains a
 * scratch call or calls another scratch value, or a `let` whose every value does.
 */
function holdsScratchValue(scope: FileScope, identifier: ts.Identifier, depth = 0): boolean {
	if (depth >= CONSTANT_DEPTH) return false

	const initializer = initializerOf(identifier)

	if (initializer) {
		if (containsScratchCall(scope, initializer)) return true

		const callee = ts.isCallExpression(initializer) ? initializer.expression : null

		return Boolean(callee && ts.isIdentifier(callee) && holdsScratchValue(scope, callee, depth + 1))
	}

	const values = letValues(identifier)

	return values.length > 0 && values.every((value) => containsScratchCall(scope, value))
}

/**
 * The scratch path a call on a scratch value names: the segments of that call,
 * or `*` when one is not a literal.
 */
function scratchTarget(args: readonly ts.Expression[], depth: number): ResolvedTarget {
	const segments = literalSegments(args, depth)

	return { root: PathRoot.Scratch, path: segments ? segments.join("/") : "*" }
}

/**
 * The root path a callable `PathBuilder` held in `identifier` joins its arguments onto,
 * or `null` when it holds none.
 *
 * `PathBuilder.from(e)` and `resolvePathBuilder(e, …)` both make one.
 */
function pathBuilderBase(scope: FileScope, identifier: ts.Identifier, depth: number): ResolvedTarget | null {
	const initializer = depth < CONSTANT_DEPTH ? initializerOf(identifier) : null

	if (!initializer || !ts.isCallExpression(initializer)) return null

	const callee = initializer.expression
	const [first, ...rest] = initializer.arguments

	if (!first) return null

	const fromClass =
		ts.isPropertyAccessExpression(callee) &&
		callee.name.text === "from" &&
		ts.isIdentifier(callee.expression) &&
		scope.bindings.get(callee.expression.text)?.kind === "path-builder-class"

	const fromFunction = ts.isIdentifier(callee) && scope.bindings.get(callee.text)?.kind === "path-builder-function"

	if (!fromClass && !fromFunction) return null

	const base = resolveTarget(scope, first, depth + 1)
	const segments = literalSegments(rest, depth)

	return base && segments ? joinTarget(base, segments) : null
}

function joinTarget(base: ResolvedTarget, segments: readonly string[]): ResolvedTarget {
	return { root: base.root, path: segments.length ? join(base.path, ...segments).toString() : base.path }
}

/**
 * The rooted path `expression` names, or `null` when its value depends on something the file does not state.
 */
function resolveTarget(scope: FileScope, expression: ts.Expression, depth = 0): ResolvedTarget | null {
	const literal = literalText(expression)

	if (literal !== null) return { root: PathRoot.Literal, path: literal }

	if (isImportMeta(expression, "dirname")) return { root: PathRoot.Repository, path: dirname(scope.file).toString() }

	if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
		return resolveTarget(scope, expression.expression, depth)
	}

	if (ts.isIdentifier(expression)) {
		const initializer = depth < CONSTANT_DEPTH ? initializerOf(expression) : null
		const resolved = initializer ? resolveTarget(scope, initializer, depth + 1) : null

		if (resolved) return resolved

		return holdsScratchValue(scope, expression) ? { root: PathRoot.Scratch, path: "*" } : null
	}

	if (
		ts.isNewExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === "URL"
	) {
		const [first, base] = expression.arguments ?? []
		const relative = first ? literalText(first) : null

		if (relative !== null && base && isImportMeta(base, "url")) {
			return { root: PathRoot.Repository, path: join(dirname(scope.file), relative).toString() }
		}

		return null
	}

	if (!ts.isCallExpression(expression)) return null

	// `scratch.path("x")` on a temporary directory, or a call on a builder derived from one, names a file the run owns.
	if (
		ts.isPropertyAccessExpression(expression.expression) &&
		expression.expression.name.text === "path" &&
		ts.isIdentifier(expression.expression.expression) &&
		holdsScratchValue(scope, expression.expression.expression)
	) {
		return scratchTarget(expression.arguments, depth)
	}

	if (!ts.isIdentifier(expression.expression)) return null

	if (holdsScratchValue(scope, expression.expression)) return scratchTarget(expression.arguments, depth)

	const builderBase = pathBuilderBase(scope, expression.expression, depth)

	if (builderBase) {
		const segments = literalSegments(expression.arguments, depth)

		return segments ? joinTarget(builderBase, segments) : null
	}

	const binding = scope.bindings.get(expression.expression.text)

	if (binding?.kind === "builder") {
		const segments = literalSegments(expression.arguments, depth)

		if (!segments) return null

		if (binding.builder.packageFirst) {
			const [packageName, ...rest] = segments

			return packageName ? { root: PathRoot.Package, path: [packageName, ...rest].join("/") } : null
		}

		return { root: binding.builder.root, path: segments.join("/") }
	}

	if (binding?.kind === "join") {
		const [first, ...rest] = expression.arguments

		if (!first) return null

		const base = resolveTarget(scope, first, depth + 1)
		const segments = literalSegments(rest, depth)

		return base && segments ? joinTarget(base, segments) : null
	}

	return null
}

function unresolvedText(scope: FileScope, nodes: readonly ts.Node[]): string {
	return nodes
		.map((node) => node.getText(scope.source))
		.join(", ")
		.slice(0, UNRESOLVED_TEXT_LENGTH)
}

function edgesOfCall(scope: FileScope, call: ts.CallExpression, effect: EffectInterface, name: string): EffectEdge[] {
	const line = scope.source.getLineAndCharacterOfPosition(call.getStart(scope.source)).line + 1
	const found: EffectEdge[] = []

	for (const parameter of effect.parameters) {
		const args = call.arguments.slice(parameter.index)
		const groups: ts.Expression[][] = parameter.each ? args.map((arg) => [arg]) : [args]

		for (const group of groups) {
			const [first, ...rest] = group

			if (!first) continue

			const pathArgs = parameter.segments ? group : [first]
			const base = resolveTarget(scope, first)
			const segments = parameter.segments ? literalSegments(rest, 0) : []
			const target = base && segments ? joinTarget(base, segments) : null

			found.push({
				file: scope.file,
				line,
				interface: name,
				kind: parameter.kind,
				target,
				unresolved: target ? null : unresolvedText(scope, pathArgs),
				unresolvedShape: target ? null : unresolvedShapeOf(first),
			})
		}
	}

	return found
}

/**
 * The effect edges of one source, in source order.
 *
 * @param file The source's path relative to the repository root, against
 * which a module-relative path resolves.
 */
export function extractEffectEdges(source: ts.SourceFile, file: string): EffectEdge[] {
	const scope: FileScope = { file, source, bindings: collectBindings(source) }
	const found: EffectEdge[] = []

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const name = node.expression.text
			const binding = scope.bindings.get(name)

			if (binding?.kind === "effect") {
				found.push(...edgesOfCall(scope, node, binding.effect, binding.effect.name))
			} else if (name === "fetch" && !scope.bindings.has(name)) {
				found.push(...edgesOfCall(scope, node, { name, parameters: [{ kind: EffectKind.Network, index: 0 }] }, name))
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return found
}
