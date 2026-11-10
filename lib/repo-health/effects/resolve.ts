/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The rooted path a source expression names, as far as the file states it.
 *
 *   A path is resolved from literals, template literals over resolvable parts, the root builders in
 *   {@linkcode PATH_BUILDER_MODULES}, a package's `paths` exports, `resolvePath` over resolvable parts,
 *   `import.meta.dirname` and `import.meta.filename`, `new URL(…, import.meta.url)`, the `const` or `using` binding a
 *   name refers to in its scope, and a call to a local function whose body is one `return`.
 */

import { dirname, join } from "path-ts"
import ts from "typescript"

import {
	API_CLIENT_MODULES,
	CONSTRUCTOR_MODULES,
	EFFECT_MODULES,
	ENVIRONMENT_OBJECTS,
	type EffectInterface,
	isEnvironmentModule,
	PATH_BUILDER_MODULES,
	type PathRootBuilder,
	PathRoot,
	STATIC_EFFECT_MODULES,
	type StaticEffectClass,
} from "#repo-health/effects/interfaces"

export interface ResolvedTarget {
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
 * The parameter of an enclosing function that `identifier` refers to, or `null` when it refers to none.
 *
 * The source must be parsed with parent nodes set.
 */
export function enclosingParameter(identifier: ts.Identifier): ts.ParameterDeclaration | null {
	for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
		if (!ts.isFunctionLike(node)) continue

		const parameter = node.parameters.find(
			(candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text
		)

		if (parameter) return parameter
	}

	return null
}

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
 * The path functions of those modules that compute a string from a path and touch no file.
 */
const PATH_STRING_FUNCTIONS = new Set([
	"relative",
	"dirname",
	"basename",
	"extname",
	"isAbsolute",
	"normalize",
	"parse",
	"format",
])

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
	| { kind: "path-string" }
	| { kind: "path-builder-class" }
	| { kind: "path-builder-function" }
	| { kind: "temporary" }
	| { kind: "api-client" }
	| { kind: "environment"; name: string }
	| { kind: "static-class"; owner: StaticEffectClass }

/**
 * One source file as the resolver reads it: its imports by local name, the `APIClient`
 * classes it declares, and the parameter bindings of the local function call being evaluated.
 */
export interface FileScope {
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

	if (PATH_JOIN_MODULES.has(specifier) && PATH_STRING_FUNCTIONS.has(imported)) return { kind: "path-string" }

	if (specifier === "path-ts" && imported === "PathBuilder") return { kind: "path-builder-class" }

	if (specifier === "path-ts" && imported === "resolvePathBuilder") return { kind: "path-builder-function" }

	if (TEMPORARY_MODULES.has(specifier) && imported === "temporaryDirectory") return { kind: "temporary" }

	if (API_CLIENT_MODULES.has(specifier) && imported === "APIClient") return { kind: "api-client" }

	if (isEnvironmentModule(specifier) && ENVIRONMENT_OBJECTS.has(imported)) {
		return { kind: "environment", name: imported }
	}

	const owner = STATIC_EFFECT_MODULES.get(specifier)?.find((candidate) => candidate.name === imported)

	if (owner) return { kind: "static-class", owner }

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
export function extendedName(node: ts.ClassLikeDeclaration): string | null {
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
 * The resolver's reading of `source`, with its imports bound through `importedPaths`.
 */
export function scopeOf(source: ts.SourceFile, file: string, importedPaths: ImportedPaths | null): FileScope {
	const bindings = collectBindings(source, importedPaths)

	return { file, source, bindings, apiClasses: collectAPIClasses(source, bindings), substitutions: new Map() }
}

/**
 * The flags of a declaration list whose bindings are never reassigned: `const`, `using` and `await using`.
 */
const FIXED_BINDINGS = ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing

export function withoutAwait(expression: ts.Expression): ts.Expression {
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
export function initializerOf(identifier: ts.Identifier): ts.Expression | null {
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

export function literalText(expression: ts.Expression): string | null {
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text

	return null
}

export function isImportMeta(expression: ts.Expression, property: string): boolean {
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
export function literalSegments(args: readonly ts.Expression[], depth: number): string[] | null {
	const segments: string[] = []

	for (const arg of args) {
		const text = literalText(arg) ?? constantLiteral(arg, depth)

		if (text === null) return null

		segments.push(text)
	}

	return segments
}

/**
 * The literal a name's fixed binding holds, followed through bindings of bindings,
 * or `null` when it holds none.
 */
export function constantLiteral(expression: ts.Expression, depth: number): string | null {
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

export function joinTarget(base: ResolvedTarget, segments: readonly string[]): ResolvedTarget {
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
export function resolveTarget(scope: FileScope, expression: ts.Expression, depth = 0): ResolvedTarget | null {
	if (depth > CONSTANT_DEPTH * 2) return null

	const literal = literalText(expression)

	if (literal !== null) return { root: PathRoot.Literal, path: literal }

	if (isImportMeta(expression, "dirname")) return { root: PathRoot.Repository, path: dirname(scope.file).toString() }

	if (isImportMeta(expression, "filename")) return { root: PathRoot.Repository, path: scope.file }

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
