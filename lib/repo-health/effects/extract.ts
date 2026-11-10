/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One source file's effect edges and the path, URL, command or variable each one names.
 *
 *   An edge comes from a call to an interface in {@linkcode EFFECT_MODULES}, a construction of a class in
 *   {@linkcode CONSTRUCTOR_MODULES}, a `fetch` call on an `APIClient`, the global `fetch`, or a read of an environment
 *   variable.
 *
 *   A path is resolved from literals, template literals over resolvable parts, the root builders in
 *   {@linkcode PATH_BUILDER_MODULES}, a package's `paths` exports, `resolvePath` over resolvable parts,
 *   `import.meta.dirname`, `new URL(…, import.meta.url)`, the `const` or `using` binding a name refers to in its scope,
 *   and a call to a local function whose body is one `return`. Anything else is recorded as unresolved with its
 *   expression, so a caller sees the call site rather than a missing edge.
 */

import { dirname, join } from "path-ts"
import ts from "typescript"

import {
	API_CLIENT_MODULES,
	CONSTRUCTOR_MODULES,
	EFFECT_MODULES,
	ENVIRONMENT_OBJECTS,
	EffectKind,
	type EffectInterface,
	isEnvironmentModule,
	PATH_BUILDER_MODULES,
	type PathRootBuilder,
	PathRoot,
} from "#repo-health/effects/interfaces"

interface ResolvedTarget {
	root: PathRoot
	path: string
}

/**
 * What one export of a package's `paths` module resolves to.
 *
 * A `constant` is a path builder rooted at `target`, which a call extends with its arguments.
 * A `function` takes a root as its first argument and answers the builder at `suffix`
 * under it, as `wofDatabaseRoot(dataRoot)` answers `<dataRoot>/db/wof`.
 */
export type RootedExport = { kind: "constant"; target: ResolvedTarget } | { kind: "function"; suffix: string }

/**
 * The resolved `paths` exports a specifier reaches from the file being read,
 * or `null` when it reaches none.
 */
export type ImportedPaths = (specifier: string) => ReadonlyMap<string, RootedExport> | null

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
	if (ts.isIdentifier(expression)) return enclosingParameter(expression) ? "parameter" : "identifier"

	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return "property"

	if (ts.isCallExpression(expression)) return "call"

	if (ts.isTemplateExpression(expression)) return "template"

	return "other"
}

/**
 * The parameter of an enclosing function that `identifier` refers to, or `null` when it refers to none.
 *
 * The source must be parsed with parent nodes set.
 */
function enclosingParameter(identifier: ts.Identifier): ts.ParameterDeclaration | null {
	for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
		if (!ts.isFunctionLike(node)) continue

		const parameter = node.parameters.find(
			(candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text
		)

		if (parameter) return parameter
	}

	return null
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
	| { kind: "constructor"; effect: EffectInterface }
	| { kind: "builder"; builder: PathRootBuilder }
	| { kind: "rooted"; rooted: RootedExport }
	| { kind: "join" }
	| { kind: "path-builder-class" }
	| { kind: "path-builder-function" }
	| { kind: "temporary" }
	| { kind: "api-client" }
	| { kind: "environment"; name: string }

interface FileScope {
	file: string
	source: ts.SourceFile
	bindings: Map<string, Binding>
	/**
	 * The classes the file declares that extend `APIClient`, directly or through another such class.
	 */
	apiClasses: Set<string>
	/**
	 * The targets the arguments of a local function call resolved to, by the parameter each one binds.
	 */
	substitutions: ReadonlyMap<ts.ParameterDeclaration, ResolvedTarget>
}

function bindingOf(specifier: string, imported: string, importedPaths: ImportedPaths | null): Binding | null {
	const effect = EFFECT_MODULES.get(specifier)?.find((candidate) => candidate.name === imported)

	if (effect) return { kind: "effect", effect }

	const constructed = CONSTRUCTOR_MODULES.get(specifier)?.find((candidate) => candidate.name === imported)

	if (constructed) return { kind: "constructor", effect: constructed }

	const builder = PATH_BUILDER_MODULES.get(specifier)?.find((candidate) => candidate.name === imported)

	if (builder) return { kind: "builder", builder }

	if (PATH_JOIN_MODULES.has(specifier) && (imported === "resolvePath" || imported === "join")) return { kind: "join" }

	if (specifier === "path-ts" && imported === "PathBuilder") return { kind: "path-builder-class" }

	if (specifier === "path-ts" && imported === "resolvePathBuilder") return { kind: "path-builder-function" }

	if (TEMPORARY_MODULES.has(specifier) && imported === "temporaryDirectory") return { kind: "temporary" }

	if (API_CLIENT_MODULES.has(specifier) && imported === "APIClient") return { kind: "api-client" }

	if (isEnvironmentModule(specifier) && ENVIRONMENT_OBJECTS.has(imported))
		return { kind: "environment", name: imported }

	const rooted = importedPaths?.(specifier)?.get(imported)

	return rooted ? { kind: "rooted", rooted } : null
}

function collectBindings(source: ts.SourceFile, importedPaths: ImportedPaths | null): Map<string, Binding> {
	const bindings = new Map<string, Binding>()

	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue

		const named = statement.importClause?.namedBindings

		if (!named || !ts.isNamedImports(named) || statement.importClause?.isTypeOnly) continue

		for (const element of named.elements) {
			if (element.isTypeOnly) continue

			const imported = (element.propertyName ?? element.name).text
			const binding = bindingOf(statement.moduleSpecifier.text, imported, importedPaths)

			if (binding) {
				bindings.set(element.name.text, binding)
			}
		}
	}

	return bindings
}

/**
 * The name of the class a class node extends, or `null` when it extends none or extends an expression.
 */
function extendedName(node: ts.ClassLikeDeclaration): string | null {
	for (const clause of node.heritageClauses ?? []) {
		if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue

		const [type] = clause.types

		return type && ts.isIdentifier(type.expression) ? type.expression.text : null
	}

	return null
}

/**
 * The classes `source` declares that extend `APIClient`, followed through classes that extend those.
 */
function collectAPIClasses(source: ts.SourceFile, bindings: ReadonlyMap<string, Binding>): Set<string> {
	const declared: Array<{ name: string; parent: string }> = []

	const visit = (node: ts.Node): void => {
		if (ts.isClassDeclaration(node) && node.name) {
			const parent = extendedName(node)

			if (parent) {
				declared.push({ name: node.name.text, parent })
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	const classes = new Set<string>()
	let grew = true

	while (grew) {
		grew = false

		for (const { name, parent } of declared) {
			const extendsClient = bindings.get(parent)?.kind === "api-client" || classes.has(parent)

			if (extendsClient && !classes.has(name)) {
				classes.add(name)
				grew = true
			}
		}
	}

	return classes
}

/**
 * The flags of a declaration list whose bindings are never reassigned: `const`, `using` and `await using`.
 */
const FIXED_BINDINGS = ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing

function withoutAwait(expression: ts.Expression): ts.Expression {
	return ts.isAwaitExpression(expression) ? expression.expression : expression
}

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

				return withoutAwait(initializer)
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

/**
 * A local function `identifier` refers to whose body is one `return` of an expression: a function
 * declaration in an enclosing block, or a `const` bound to an arrow or function expression.
 * `null` for any other function.
 */
function localFunctionOf(
	identifier: ts.Identifier
): { parameters: readonly ts.ParameterDeclaration[]; returned: ts.Expression } | null {
	let declared: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null = null

	for (let node: ts.Node | undefined = identifier.parent; node && !declared; node = node.parent) {
		if (!(ts.isBlock(node) || ts.isSourceFile(node))) continue

		for (const statement of node.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === identifier.text) {
				declared = statement
			}
		}
	}

	if (!declared) {
		const initializer = initializerOf(identifier)

		if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
			declared = initializer
		}
	}

	if (!declared) return null

	const body = declared.body

	if (!body) return null

	if (!ts.isBlock(body)) return { parameters: declared.parameters, returned: body }

	const [only, ...others] = body.statements

	if (others.length || !only || !ts.isReturnStatement(only) || !only.expression) return null

	return { parameters: declared.parameters, returned: only.expression }
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

	return initializer && ts.isCallExpression(initializer) ? pathBuilderOf(scope, initializer, depth) : null
}

/**
 * The root path of the `PathBuilder` that `PathBuilder.from(e)` or `resolvePathBuilder(e, …)`
 * makes, or `null` when `call` is neither.
 */
function pathBuilderOf(scope: FileScope, call: ts.CallExpression, depth: number): ResolvedTarget | null {
	const callee = call.expression
	const [first, ...rest] = call.arguments

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
	const [first, ...rest] = segments.filter((segment) => segment !== "")

	if (first === undefined) return base

	return { root: base.root, path: join(base.path || first, ...(base.path ? [first, ...rest] : rest)).toString() }
}

/**
 * The text a template literal resolves to, as a literal, or as a path under a root
 * when its first part is a rooted path and every later part is literal.
 */
function resolveTemplate(scope: FileScope, template: ts.TemplateExpression, depth: number): ResolvedTarget | null {
	let base: ResolvedTarget | null = null
	let text = template.head.text

	for (const [index, span] of template.templateSpans.entries()) {
		const part = resolveTarget(scope, span.expression, depth + 1)

		if (!part) return null

		if (part.root === PathRoot.Literal) {
			text += part.path
		} else if (index === 0 && text === "") {
			base = part
		} else {
			return null
		}

		text += span.literal.text
	}

	return base ? joinTarget(base, [text.replace(/^\/+/, "")]) : { root: PathRoot.Literal, path: text }
}

/**
 * The target a call to a local function whose body is one `return` resolves to,
 * with each parameter bound to the target its argument resolves to.
 */
function resolveLocalCall(scope: FileScope, call: ts.CallExpression, depth: number): ResolvedTarget | null {
	if (!ts.isIdentifier(call.expression) || depth >= CONSTANT_DEPTH) return null

	const local = localFunctionOf(call.expression)

	if (!local) return null

	const substitutions = new Map(scope.substitutions)

	for (const [index, parameter] of local.parameters.entries()) {
		const arg = call.arguments[index]
		const target = arg ? resolveTarget(scope, arg, depth + 1) : null

		if (target) {
			substitutions.set(parameter, target)
		}
	}

	return resolveTarget({ ...scope, substitutions }, local.returned, depth + 1)
}

function resolveIdentifier(scope: FileScope, identifier: ts.Identifier, depth: number): ResolvedTarget | null {
	const parameter = enclosingParameter(identifier)
	const substituted = parameter ? scope.substitutions.get(parameter) : undefined

	if (substituted) return substituted

	const initializer = depth < CONSTANT_DEPTH ? initializerOf(identifier) : null
	const resolved = initializer ? resolveTarget(scope, initializer, depth + 1) : null

	if (resolved) return resolved

	const binding = scope.bindings.get(identifier.text)

	if (binding?.kind === "rooted" && binding.rooted.kind === "constant") return binding.rooted.target

	return holdsScratchValue(scope, identifier) ? { root: PathRoot.Scratch, path: "*" } : null
}

function resolveBuilderCall(
	scope: FileScope,
	builder: PathRootBuilder,
	args: readonly ts.Expression[],
	depth: number
): ResolvedTarget | null {
	if (builder.rebases) {
		const [first] = args
		const base = first ? resolveTarget(scope, first, depth + 1) : null

		return base ? joinTarget(base, builder.rebases) : null
	}

	const segments = literalSegments(args, depth)

	if (!segments) return null

	if (builder.packageFirst) {
		const [packageName, ...rest] = segments

		return packageName ? { root: PathRoot.Package, path: [packageName, ...rest].join("/") } : null
	}

	return { root: builder.root, path: segments.join("/") }
}

function resolveCall(scope: FileScope, call: ts.CallExpression, depth: number): ResolvedTarget | null {
	const callee = call.expression

	// `scratch.path("x")` on a temporary directory, or a call on a builder derived from one, names a file the run owns.
	if (
		ts.isPropertyAccessExpression(callee) &&
		callee.name.text === "path" &&
		ts.isIdentifier(callee.expression) &&
		holdsScratchValue(scope, callee.expression)
	) {
		return scratchTarget(call.arguments, depth)
	}

	const fromPathBuilder = pathBuilderOf(scope, call, depth)

	if (fromPathBuilder) return fromPathBuilder

	// A call on a call, as in `databaseRootPath(root)("wof")`: the inner call answers a builder the outer one extends.
	if (ts.isCallExpression(callee)) {
		const base = resolveCall(scope, callee, depth + 1)
		const segments = literalSegments(call.arguments, depth)

		return base && segments ? joinTarget(base, segments) : null
	}

	if (!ts.isIdentifier(callee)) return null

	if (holdsScratchValue(scope, callee)) return scratchTarget(call.arguments, depth)

	const binding = scope.bindings.get(callee.text)

	if (binding?.kind === "builder") return resolveBuilderCall(scope, binding.builder, call.arguments, depth)

	if (binding?.kind === "join") {
		const [first, ...rest] = call.arguments

		if (!first) return null

		const base = resolveTarget(scope, first, depth + 1)
		const segments = literalSegments(rest, depth)

		return base && segments ? joinTarget(base, segments) : null
	}

	if (binding?.kind === "rooted" && binding.rooted.kind === "function") {
		const [first] = call.arguments
		const base = first ? resolveTarget(scope, first, depth + 1) : null

		return base ? joinTarget(base, [binding.rooted.suffix]) : null
	}

	const local = resolveLocalCall(scope, call, depth)

	if (local) return local

	// A name holding a builder, such as a `paths` constant or `const wof = wofDatabaseRoot(root)`, extends it.
	const base = pathBuilderBase(scope, callee, depth) ?? resolveIdentifier(scope, callee, depth + 1)
	const segments = literalSegments(call.arguments, depth)

	return base && base.root !== PathRoot.Literal && segments ? joinTarget(base, segments) : null
}

/**
 * The rooted path `expression` names, or `null` when its value depends on something the file does not state.
 */
function resolveTarget(scope: FileScope, expression: ts.Expression, depth = 0): ResolvedTarget | null {
	if (depth > CONSTANT_DEPTH * 2) return null

	const literal = literalText(expression)

	if (literal !== null) return { root: PathRoot.Literal, path: literal }

	if (isImportMeta(expression, "dirname")) return { root: PathRoot.Repository, path: dirname(scope.file).toString() }

	if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isAwaitExpression(expression)) {
		return resolveTarget(scope, expression.expression, depth)
	}

	if (ts.isTemplateExpression(expression)) return resolveTemplate(scope, expression, depth)

	if (ts.isIdentifier(expression)) return resolveIdentifier(scope, expression, depth)

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

	return ts.isCallExpression(expression) ? resolveCall(scope, expression, depth) : null
}

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

		for (const group of groups) {
			const [first, ...rest] = group

			if (!first) continue

			const base = resolveTarget(scope, first)
			const segments = parameter.segments ? literalSegments(rest, 0) : []
			const target = base && segments ? joinTarget(base, segments) : null

			if (target?.root === PathRoot.Literal && target.path === MEMORY_DATABASE) continue

			found.push(edgeOf(scope, call, effect.name, kind, first, target, parameter.segments ? group : [first]))
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

	for (const element of options.properties) {
		if (ts.isPropertyAssignment(element) && ts.isIdentifier(element.name) && element.name.text === "url") {
			const target = resolveTarget(scope, element.initializer)

			return edgeOf(scope, call, name, EffectKind.Network, element.initializer, target)
		}

		if (ts.isShorthandPropertyAssignment(element) && element.name.text === "url") {
			const target = resolveTarget(scope, element.name)

			return edgeOf(scope, call, name, EffectKind.Network, element.name, target)
		}
	}

	return edgeOf(scope, call, name, EffectKind.Network, options, null)
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
	const variable = resolveTarget(scope, key)
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

function scopeOf(source: ts.SourceFile, file: string, importedPaths: ImportedPaths | null): FileScope {
	const bindings = collectBindings(source, importedPaths)

	return { file, source, bindings, apiClasses: collectAPIClasses(source, bindings), substitutions: new Map() }
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
	const scope = scopeOf(source, file, importedPaths)
	const found: EffectEdge[] = []

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const name = node.expression.text
			const binding = scope.bindings.get(name)

			if (binding?.kind === "effect") {
				found.push(...edgesOfCall(scope, node, binding.effect))
			} else if (name === "fetch" && !scope.bindings.has(name)) {
				found.push(...edgesOfCall(scope, node, { name, parameters: [{ kind: EffectKind.Network, index: 0 }] }))
			}
		} else if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "fetch" &&
			isAPIClientReceiver(scope, node.expression.expression)
		) {
			found.push(edgeOfAPIFetch(scope, node))
		} else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
			const binding = scope.bindings.get(node.expression.text)

			if (binding?.kind === "constructor") {
				found.push(...edgesOfCall(scope, node, binding.effect))
			}
		} else {
			const uses = edgesOfProcessEnvUse(scope, node)
			const read = uses ? null : edgeOfEnvironmentRead(scope, node)

			if (uses) {
				found.push(...uses)
			} else if (read) {
				found.push(read)
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(source)

	return found
}

/**
 * What each export of a `paths` module resolves to: each exported `const` that resolves to a rooted
 * path, and each exported function whose one `return` resolves to a path under its first argument.
 */
export function summarizeRootedExports(
	source: ts.SourceFile,
	file: string,
	importedPaths: ImportedPaths | null = null
): Map<string, RootedExport> {
	const scope = scopeOf(source, file, importedPaths)
	const exported = new Map<string, RootedExport>()

	const isExported = (statement: ts.Statement): boolean =>
		ts.canHaveModifiers(statement) &&
		Boolean(ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))

	for (const statement of source.statements) {
		if (!isExported(statement)) continue

		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue

				const target = resolveTarget(scope, withoutAwait(declaration.initializer))

				if (target && target.root !== PathRoot.Literal && target.root !== PathRoot.Argument) {
					exported.set(declaration.name.text, { kind: "constant", target })
				}
			}
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			const local = localFunctionOf(statement.name)
			const [rootParameter] = local?.parameters ?? []

			if (!local || !rootParameter) continue

			const substitutions = new Map([[rootParameter, { root: PathRoot.Argument, path: "" }]])
			const target = resolveTarget({ ...scope, substitutions }, local.returned)

			if (target?.root === PathRoot.Argument) {
				exported.set(statement.name.text, { kind: "function", suffix: target.path })
			}
		}
	}

	return exported
}
