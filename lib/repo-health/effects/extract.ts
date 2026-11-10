/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One source file's effect edges and the path, URL, command or variable each one names.
 *
 *   An edge comes from a call to an interface in {@linkcode EFFECT_MODULES}, a static method in
 *   {@linkcode STATIC_EFFECT_MODULES}, a construction of a class in {@linkcode CONSTRUCTOR_MODULES}, a `fetch` call on an
 *   `APIClient`, the global `fetch`, or a read of an environment variable. `#repo-health/effects/resolve` resolves each
 *   path. Anything it cannot resolve is recorded as unresolved with its expression, so a caller sees the call site
 *   rather than a missing edge.
 */

import ts from "typescript"

import { EffectKind, type EffectInterface, PathRoot } from "#repo-health/effects/interfaces"
import {
	enclosingParameter,
	extendedName,
	type FileScope,
	type ImportedPaths,
	initializerOf,
	joinTarget,
	literalSegments,
	type ResolvedTarget,
	targetOfExpression,
	bindSourceScope,
	withoutAwait,
} from "#repo-health/effects/resolve"

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
	/**
	 * Present and `true` when the call reads the target's own metadata, such as a stat
	 * or a real path, rather than its content or the files beneath it.
	 */
	exact?: true
}

type UnresolvedShape = "parameter" | "identifier" | "property" | "call" | "template" | "other"

function unresolvedShapeOf(expression: ts.Expression): UnresolvedShape {
	if (ts.isIdentifier(expression)) return enclosingParameter(expression) ? "parameter" : "identifier"

	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return "property"

	if (ts.isCallExpression(expression)) return "call"

	if (ts.isTemplateExpression(expression)) return "template"

	return "other"
}

const UNRESOLVED_TEXT_LENGTH = 120

function unresolvedText(scope: FileScope, nodes: readonly ts.Node[]): string {
	return nodes
		.map((node) => node.getText(scope.source))
		.join(", ")
		.slice(0, UNRESOLVED_TEXT_LENGTH)
}

function lineOf(scope: FileScope, node: ts.Node): number {
	return scope.source.getLineAndCharacterOfPosition(node.getStart(scope.source)).line + 1
}

function edgeOf(
	scope: FileScope,
	node: ts.Node,
	name: string,
	kind: EffectKind,
	path: ts.Expression | null,
	target: ResolvedTarget | null,
	text: readonly ts.Node[] = path ? [path] : []
): EffectEdge {
	return {
		file: scope.file,
		line: lineOf(scope, node),
		interface: name,
		kind,
		target,
		unresolved: target ? null : unresolvedText(scope, text),
		unresolvedShape: target ? null : path ? unresolvedShapeOf(path) : "other",
	}
}

/**
 * Whether the object literal at argument `index` of `call` sets `property` to `true`.
 */
function setsOption(call: ts.CallExpression | ts.NewExpression, index: number, property: string): boolean {
	const options = call.arguments?.[index]

	if (!options || !ts.isObjectLiteralExpression(options)) return false

	return options.properties.some(
		(element) =>
			ts.isPropertyAssignment(element) &&
			ts.isIdentifier(element.name) &&
			element.name.text === property &&
			element.initializer.kind === ts.SyntaxKind.TrueKeyword
	)
}

/**
 * The path `SQLite` opens as a memory-only database.
 * A connection to it reads and writes memory only.
 */
const MEMORY_DATABASE = ":memory:"

/**
 * The value an object literal gives `property`, as an assignment or a shorthand,
 * or `null` when it gives none.
 */
function propertyValue(options: ts.Expression, property: string): ts.Expression | null {
	if (!ts.isObjectLiteralExpression(options)) return null

	for (const element of options.properties) {
		if (ts.isPropertyAssignment(element) && ts.isIdentifier(element.name) && element.name.text === property) {
			return element.initializer
		}

		if (ts.isShorthandPropertyAssignment(element) && element.name.text === property) return element.name
	}

	return null
}

function edgesOfCall(
	scope: FileScope,
	call: ts.CallExpression | ts.NewExpression,
	effect: EffectInterface
): EffectEdge[] {
	const found: EffectEdge[] = []
	const args = call.arguments ?? []

	for (const parameter of effect.parameters) {
		const groups: ts.Expression[][] = parameter.each
			? args.slice(parameter.index).map((arg) => [arg])
			: [args.slice(parameter.index)]

		const kind =
			parameter.option && setsOption(call, parameter.option.argument, parameter.option.property)
				? parameter.option.kind
				: parameter.kind

		if (parameter.property) {
			const options = args[parameter.index]
			const path = options ? propertyValue(options, parameter.property) : null
			const target = path ? targetOfExpression(scope, path) : null

			found.push(edgeOf(scope, call, effect.name, kind, path, target, [path ?? options ?? call]))

			continue
		}

		for (const group of groups) {
			const [first, ...rest] = group

			if (!first) continue

			const base = targetOfExpression(scope, first)
			const segments = parameter.segments ? literalSegments(rest, 0) : []
			const target = base && segments ? joinTarget(base, segments) : null

			if (target?.root === PathRoot.Literal && target.path === MEMORY_DATABASE) continue

			const edge = edgeOf(scope, call, effect.name, kind, first, target, parameter.segments ? group : [first])

			found.push(parameter.exact ? { ...edge, exact: true } : edge)
		}
	}

	return found
}

function constructsAPIClient(scope: FileScope, expression: ts.Expression): boolean {
	const bare = withoutAwait(expression)

	if (!ts.isNewExpression(bare) || !ts.isIdentifier(bare.expression)) return false

	const name = bare.expression.text

	return scope.bindings.get(name)?.kind === "api-client" || scope.apiClasses.has(name)
}

function enclosingClassIsAPIClient(scope: FileScope, node: ts.Node): boolean {
	for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
		if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
			const parent = extendedName(current)
			const named = current.name?.text

			return Boolean(
				(named && scope.apiClasses.has(named)) || (parent && scope.bindings.get(parent)?.kind === "api-client")
			)
		}
	}

	return false
}

/**
 * Whether the receiver of a `fetch` call is an `APIClient`: `this` inside a subclass,
 * a construction, or a fixed binding of one.
 */
function isAPIClientReceiver(scope: FileScope, receiver: ts.Expression): boolean {
	if (receiver.kind === ts.SyntaxKind.ThisKeyword) return enclosingClassIsAPIClient(scope, receiver)

	if (ts.isParenthesizedExpression(receiver)) return isAPIClientReceiver(scope, receiver.expression)

	if (constructsAPIClient(scope, receiver)) return true

	if (!ts.isIdentifier(receiver)) return false

	const initializer = initializerOf(receiver)

	return Boolean(initializer && constructsAPIClient(scope, initializer))
}

/**
 * The network edge of an `APIClient` `fetch` call.
 * Its target is the `url` the request options state.
 */
function edgeOfAPIFetch(scope: FileScope, call: ts.CallExpression): EffectEdge {
	const [options] = call.arguments
	const name = "APIClient.fetch"

	if (!options || !ts.isObjectLiteralExpression(options)) {
		return edgeOf(scope, call, name, EffectKind.Network, options ?? null, null)
	}

	const url = propertyValue(options, "url")

	return edgeOf(scope, call, name, EffectKind.Network, url ?? options, url ? targetOfExpression(scope, url) : null)
}

function isProcessEnv(scope: FileScope, node: ts.Node): node is ts.PropertyAccessExpression {
	return (
		ts.isPropertyAccessExpression(node) &&
		node.name.text === "env" &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "process" &&
		!scope.bindings.has("process")
	)
}

/**
 * Whether `identifier` is the declared name of a binding, parameter, property
 * or member rather than a value it reads.
 */
function isDeclaredName(identifier: ts.Identifier): boolean {
	const parent = identifier.parent

	if (ts.isPropertyAccessExpression(parent)) return parent.name === identifier

	return (
		(ts.isVariableDeclaration(parent) ||
			ts.isParameter(parent) ||
			ts.isBindingElement(parent) ||
			ts.isPropertyAssignment(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isPropertySignature(parent) ||
			ts.isMethodDeclaration(parent)) &&
		parent.name === identifier
	)
}

/**
 * Whether `node` evaluates to `process.env`: the expression itself, or a fixed
 * binding of it such as `const env = process.env`.
 */
function refersToProcessEnv(scope: FileScope, node: ts.Node): boolean {
	if (isProcessEnv(scope, node)) return true

	if (!ts.isIdentifier(node) || isDeclaredName(node)) return false

	const initializer = initializerOf(node)

	return Boolean(initializer && isProcessEnv(scope, initializer))
}

/**
 * The variable every environment edge targets when code receives the whole environment:
 * a child process given `process.env`, an object spread from it, or `Object.entries(process.env)`.
 */
const EVERY_VARIABLE = "*"

/**
 * The environment edge of a property read on an environment object, or `null` when `node` is none.
 */
function edgeOfEnvironmentRead(scope: FileScope, node: ts.Node): EffectEdge | null {
	if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null

	const object = node.expression
	let name: string | null = null

	if (refersToProcessEnv(scope, object)) {
		name = "process.env"
	} else if (ts.isIdentifier(object)) {
		const binding = scope.bindings.get(object.text)

		name = binding?.kind === "environment" ? binding.name : null
	}

	if (!name) return null

	if (ts.isPropertyAccessExpression(node)) {
		return edgeOf(scope, node, name, EffectKind.Environment, node.name, {
			root: PathRoot.Environment,
			path: node.name.text,
		})
	}

	const key = node.argumentExpression
	const variable = targetOfExpression(scope, key)
	const target = variable?.root === PathRoot.Literal ? { root: PathRoot.Environment, path: variable.path } : null

	return edgeOf(scope, node, name, EffectKind.Environment, key, target)
}

/**
 * The environment edges of `node` when it evaluates to `process.env` outside a
 * property read, or `null` when it does not.
 *
 * A destructuring declaration reads each property it names, and a rest element reads every variable.
 * A fixed binding such as `const env = process.env` adds no edge at its declaration,
 * because each read through it is an edge of its own.
 *
 * Any other use receives the whole environment, so its edge targets every variable.
 */
function edgesOfProcessEnvUse(scope: FileScope, node: ts.Node): EffectEdge[] | null {
	if (!refersToProcessEnv(scope, node)) return null

	const parent = node.parent

	if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) {
		return null
	}

	const variableOf = (path: string): ResolvedTarget => ({ root: PathRoot.Environment, path })

	const edgeTo = (at: ts.Node, path: string) =>
		edgeOf(scope, at, "process.env", EffectKind.Environment, null, variableOf(path))

	if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
		if (ts.isIdentifier(parent.name)) return []

		if (ts.isObjectBindingPattern(parent.name)) {
			return parent.name.elements.map((element) => {
				const key = element.propertyName ?? element.name

				if (element.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteral(key))) {
					return edgeTo(element, EVERY_VARIABLE)
				}

				return edgeTo(element, key.text)
			})
		}
	}

	return [edgeTo(node, EVERY_VARIABLE)]
}

/**
 * The static effect method `call` invokes on an imported class, such as `JSONSpliterator.fromAsync`,
 * with its `name` set to `<class>.<method>`, or `null` when it invokes none.
 */
function staticEffectOf(scope: FileScope, call: ts.CallExpression): EffectInterface | null {
	const callee = call.expression

	if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null

	const binding = scope.bindings.get(callee.expression.text)

	if (binding?.kind !== "static-class") return null

	const method = binding.owner.methods.find((candidate) => candidate.name === callee.name.text)

	return method ? { ...method, name: `${binding.owner.name}.${method.name}` } : null
}

/**
 * The edges one node adds, apart from those of its children.
 */
function edgesAt(scope: FileScope, node: ts.Node): EffectEdge[] {
	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
		const name = node.expression.text
		const binding = scope.bindings.get(name)

		if (binding?.kind === "effect") return edgesOfCall(scope, node, binding.effect)

		if (name === "fetch" && !scope.bindings.has(name)) {
			return edgesOfCall(scope, node, { name, parameters: [{ kind: EffectKind.Network, index: 0 }] })
		}

		return []
	}

	if (ts.isCallExpression(node)) {
		const callee = node.expression

		if (
			ts.isPropertyAccessExpression(callee) &&
			callee.name.text === "fetch" &&
			isAPIClientReceiver(scope, callee.expression)
		) {
			return [edgeOfAPIFetch(scope, node)]
		}

		const method = staticEffectOf(scope, node)

		if (method) return edgesOfCall(scope, node, method)
	}

	if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
		const binding = scope.bindings.get(node.expression.text)

		return binding?.kind === "constructor" ? edgesOfCall(scope, node, binding.effect) : []
	}

	const uses = edgesOfProcessEnvUse(scope, node)

	if (uses) return uses

	const read = edgeOfEnvironmentRead(scope, node)

	return read ? [read] : []
}

/**
 * The effect edges of one source, in source order.
 *
 * @param file The source's path relative to the repository root, against
 * which a module-relative path resolves.
 * @param importedPaths The `paths` exports each import specifier reaches from this file.
 */
export function extractEffectEdges(
	source: ts.SourceFile,
	file: string,
	importedPaths: ImportedPaths | null = null
): EffectEdge[] {
	const scope = bindSourceScope(source, file, importedPaths)
	const found: EffectEdge[] = []

	const visit = (node: ts.Node): void => {
		found.push(...edgesAt(scope, node))
		ts.forEachChild(node, visit)
	}

	visit(source)

	return found
}
