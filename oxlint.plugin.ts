/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Mailwoman's repo-local oxlint JS plugin (ESLint v9-compatible API), loaded alongside the
 *   bundled Sister Software plugin via `jsPlugins` in `oxlint.config.ts`. Rules encoding
 *   mailwoman-specific guidance live here; anything general enough for other repos graduates to
 *   `@sister.software/oxlint-config`.
 *
 *   `no-sync-fs-in-async`: a synchronous `node:fs` call standing inside an `async` function blocks the event loop
 *   where an `await` is already legal on the same line. The rule fires only in that position — a sync call inside a
 *   sync function is a cascade, not a defect, and the rule stays silent there.
 *
 *   `no-relative-dynamic-import`: `import("./x.ts")` names a module by the importer's location; the package's
 *   `imports` map names it once.
 *
 *   `no-private-import-in-test`: a test file reaches the package under test through its public exports, never the
 *   `#` map — the map is the package's private naming, and a test that uses it never exercises the surface a consumer
 *   gets.
 *
 *   `no-import-meta-dirname-walk`: `resolvePath(import.meta.dirname, "../..")` counts directories; a package's own
 *   file is `resolvePackagePath`, a repository file is `repoRootPath`.
 *
 *   `no-import-meta-resolve`: `fileURLToPath(import.meta.resolve(…))` has a typed home in
 *   `@mailwoman/core/module/resolvers`.
 *
 *   `prefer-home`: the table is `oxlint.helper-homes.ts` and this file matches its signatures. A row matches a token,
 *   a control shape or an interpolation order: the shuffle writes no constant of its own and a hand-written address
 *   order writes nothing but a comma, so a table that only knew literals could report neither.
 *
 *   `prefer-spliterator`: `text.split("\n")` (or `"\t"`) materializes every segment into one array
 *   before the first is read — the whole-buffer parse the spliterator library exists to avoid (the
 *   quadratic-CSV episode in AGENTS.md started exactly there). The rule warns on those two literal
 *   delimiters only; splitting on anything else is not a streaming shape and stays silent.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { AstNode } from "@sister.software/oxlint-config/plugin-types"

import { HELPER_HOMES, type HelperHome } from "./oxlint.helper-homes.ts"

interface RuleContext {
	options: unknown[]
	report(descriptor: { node: unknown; message: string }): void
	sourceCode?: SourceCode
	getSourceCode?(): SourceCode
}

interface CommentNode {
	type: string
	range: [number, number]
	value: string
}

interface SourceCode {
	getAllComments(): CommentNode[]
}

interface Rule {
	meta: { name: string; type: string; schema: unknown[] }
	create(context: RuleContext): Record<string, (node: AstNode) => void>
}

interface Plugin {
	meta: { name: string }
	rules: Record<string, Rule>
}

/**
 * The delimiters the rule understands, each mapped to the spliterator entry point that streams it.
 */
const DELIMITER_HINTS = new Map<string, { rendered: string; hints: string[] }>([
	[
		"\n",
		{ rendered: String.raw`"\n"`, hints: ["TextSpliterator", "CSVSpliterator", "TSVSpliterator", "JSONSpliterator"] },
	],
	["\t", { rendered: String.raw`"\t"`, hints: ["TSVSpliterator"] }],
])

/**
 * The delimiter string when the argument is a plain string literal or an expressionless template literal, else null.
 */
function literalDelimiter(argument: AstNode | undefined): string | null {
	if (!argument) return null

	if ((argument.type === "Literal" || argument.type === "StringLiteral") && typeof argument.value === "string") {
		return argument.value
	}

	if (argument.type === "TemplateLiteral" && !argument.expressions?.length && argument.quasis?.length === 1) {
		return argument.quasis[0]?.value?.cooked ?? null
	}

	return null
}

const preferSpliteratorRule: Rule = {
	meta: {
		name: "prefer-spliterator",
		type: "suggestion",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			CallExpression(node: AstNode) {
				const callee = node.callee

				if (!callee) return

				if (callee.type !== "MemberExpression" && callee.type !== "StaticMemberExpression") return

				if (callee.property?.type !== "Identifier" || callee.property.name !== "split") return

				const delimiter = literalDelimiter(node.arguments?.[0])
				const entry = delimiter === null ? undefined : DELIMITER_HINTS.get(delimiter)

				if (!entry) return

				context.report({
					node,
					message:
						`split(${entry.rendered}) materializes every segment before the first is read — prefer ` +
						`spliterator's ${entry.hints.map((h) => `\`${h}\``).join(", ")}. Each has a synchronous \`from\` and an asynchronous \`fromAsync\`; prefer \`fromAsync\`, which returns a chainable \`AsyncSequence\`.\n` +
						`Needing every line resident is not on its own a reason to split: \`.filter(…).toArray()\` filters while streaming, so only what survives is materialized, and \`.map((line, index) => …)\` supplies line numbers without an intermediate array.\n` +
						`If the input is small and bounded (and will not grow in the future), keep split behind a scoped disable stating why.`,
				})
			},
		}
	},
}

/**
 * Kysely calls whose arguments are checked against the database schema.
 */
const DATABASE_BOUNDARY_METHODS = new Set([
	"deleteFrom",
	"insertInto",
	"mergeInto",
	"replaceInto",
	"selectFrom",
	"updateTable",
	"values",
])

/**
 * Whether an expression contains a cast through `never`, including a nested `as unknown as never`.
 */
function containsNeverCast(node: AstNode | undefined): boolean {
	if (!node) return false

	if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
		if (node.typeAnnotation?.type === "TSNeverKeyword") return true

		return containsNeverCast(node.expression)
	}

	return false
}

/**
 * The identifier name of a non-computed member call, if this is one.
 */
function calledMethod(node: AstNode): string | null {
	const callee = node.callee

	if (!callee || (callee.type !== "MemberExpression" && callee.type !== "StaticMemberExpression")) return null

	return callee.property?.type === "Identifier" ? (callee.property.name ?? null) : null
}

/**
 * Type names whose whole purpose is to carry a database schema.
 */
const DATABASE_HANDLE_TYPES = new Set(["DatabaseClient", "Kysely", "Transaction"])

/**
 * The type name of a cast's target, when the target is a plain (possibly generic) type reference.
 */
function castTargetName(node: AstNode): string | null {
	const annotation = node.typeAnnotation

	if (annotation?.type !== "TSTypeReference") return null

	return annotation.typeName?.type === "Identifier" ? (annotation.typeName.name ?? null) : null
}

const noDatabaseHandleCastRule: Rule = {
	meta: {
		name: "no-database-handle-cast",
		type: "problem",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			TSAsExpression(node: AstNode) {
				const name = castTargetName(node)

				if (!name || !DATABASE_HANDLE_TYPES.has(name)) return

				context.report({
					node,
					message:
						`Do not cast a database handle to \`${name}<…>\`. Kysely is INVARIANT in its schema parameter, so a ` +
						"handle over a schema that EXTENDS the one a helper wants is not assignable to it — but the " +
						"incompatibility lives in `transaction()` and `with()`, which such helpers do not call. Narrow the " +
						'HELPER\'S PARAMETER to the members it actually uses (`Pick<Kysely<Schema>, "insertInto" | "schema" ' +
						'| "selectFrom">`) and the caller passes its own handle with no cast at all; `LayerContractHandle` ' +
						"in `@mailwoman/core/layers` is the worked example. A cast here does not skip one check — it disarms " +
						"every column-level guarantee those tables carry, branded normalization keys included.",
				})
			},
		}
	},
}

const requireDatabaseSchemaArgumentRule: Rule = {
	meta: {
		name: "require-database-schema-argument",
		type: "problem",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			NewExpression(node: AstNode) {
				const callee = node.callee

				if (callee?.type !== "Identifier" || !DATABASE_HANDLE_TYPES.has(callee.name ?? "")) return

				if (node.typeArguments?.params?.length) return

				context.report({
					node,
					message:
						`\`new ${callee.name}(…)\` without a schema type argument falls back to the EMPTY schema ` +
						"(`Record<string, never>`), so every table name is `never` and the next writer reaches for a cast in " +
						"order to compile. Pass the artifact's own `Database` interface. If none exists, declare it beside " +
						"the reader together with its `createXTable` builder, so a column added to one is a compile error " +
						"against the other.",
				})
			},
		}
	},
}

const noDatabaseBoundaryCastRule: Rule = {
	meta: {
		name: "no-database-boundary-cast",
		type: "problem",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			CallExpression(node: AstNode) {
				const method = calledMethod(node)

				if (!method || !DATABASE_BOUNDARY_METHODS.has(method)) return

				for (const argument of node.arguments ?? []) {
					if (!containsNeverCast(argument)) continue

					context.report({
						node: argument,
						message:
							`Do not cast through \`never\` at a database boundary (.${method}()). This disables every schema ` +
							"guarantee, including branded normalization keys. Give `DatabaseClient`/`Kysely` its real database " +
							"schema type instead.",
					})
				}
			},
		}
	},
}

const OXLINT_DISABLE_DIRECTIVE = /\boxlint-disable(?:-next-line|-line)?\b/u

const requireDisableReasonRule: Rule = {
	meta: {
		name: "require-disable-reason",
		type: "problem",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			Program() {
				const sourceCode = context.sourceCode ?? context.getSourceCode?.()

				if (!sourceCode) return

				for (const comment of sourceCode.getAllComments()) {
					if (!OXLINT_DISABLE_DIRECTIVE.test(comment.value) || comment.value.includes("--")) continue

					context.report({
						node: comment,
						message:
							"An oxlint suppression must explain why the forbidden shape is correct here. Add `-- reason` " +
							"on the directive itself; a nearby comment can drift away or leave the disable behind.",
					})
				}
			},
		}
	},
}

/**
 * Each synchronous `node:fs` name, mapped to the asynchronous helper that replaces it. The three removal helpers and
 * the two stat helpers differ in what they treat as an error, so the suggestion names the builtin's own contract rather
 * than the nearest-looking helper.
 */
const GLOBERATOR_DIRECTORY_HINT =
	'`Globerator.from("*", { cwd: path, absolute: false })`, adding `withFileTypes: true, onlyFiles: false` when entry types are needed (spliterator/node/fs)'

const ASYNC_FILESYSTEM_HELPERS = new Map<string, string>([
	["appendFileSync", "`appendLocalTextFile(content, path)` (@mailwoman/core/fs/writers)"],
	["chmodSync", "`changeMode(path, mode)` (@mailwoman/core/fs/writers)"],
	["copyFileSync", "`copyFileTo(source, destination)` (@mailwoman/core/fs/writers)"],
	["cpSync", "`copyPath(source, destination)` (@mailwoman/core/fs/writers)"],
	["existsSync", "`pathExists(path)` (@mailwoman/core/fs/readers)"],
	["lstatSync", "`statLink(path)` (@mailwoman/core/fs/readers)"],
	[
		"mkdirSync",
		"`makeDirectories(...paths)` when the call passes `{ recursive: true }`, and `makeDirectoryExclusive(path)` " +
			"when it does not — bare `mkdir` raises EEXIST, which is how a lock is held (@mailwoman/core/fs/writers)",
	],
	["mkdtempSync", "`temporaryDirectory(prefix)` (@mailwoman/core/fs/temporary), bound with `await using`"],
	["readFileSync", "`readLocalTextFile(path)` or `readLocalBuffer(path)` (@mailwoman/core/fs/readers)"],
	["readdirSync", GLOBERATOR_DIRECTORY_HINT],
	["realpathSync", "`realPath(path)`, or `tryRealPath(path)` for null-on-absent (@mailwoman/core/fs/readers)"],
	["renameSync", "`movePath(source, destination)` (@mailwoman/core/fs/writers)"],
	[
		"rmSync",
		"`removePathIfPresent(path)` for `rm -rf`, or `removePath(path)` where absence should raise " +
			"(@mailwoman/core/fs/writers)",
	],
	["statSync", "`statPath(path)`, or `tryStat(path)` for null-on-absent (@mailwoman/core/fs/readers)"],
	["symlinkSync", "`createSymbolicLink(target, linkPath)` (@mailwoman/core/fs/writers)"],
	["unlinkSync", "`removePath(path)` (@mailwoman/core/fs/writers)"],
	["utimesSync", "`setTimestamps(path, accessedAt, modifiedAt)` (@mailwoman/core/fs/writers)"],
	[
		"writeFileSync",
		"`writeLocalTextFile(content, path)` or `writeLocalBuffer(bytes, path)` (@mailwoman/core/fs/writers)",
	],
])

const FUNCTION_NODE_TYPES = new Set([
	"ArrowFunctionExpression",
	"FunctionDeclaration",
	"FunctionExpression",
	"TSDeclareFunction",
])

/**
 * Node types that end an `async` scope without being a function: whatever they contain runs synchronously however the
 * surrounding function was declared.
 */
const SYNC_SCOPE_NODE_TYPES = new Set(["ClassStaticBlock", "StaticBlock", "MethodDefinition", "PropertyDefinition"])

const MOCKING_FUNCTIONS = new Set(["mock", "doMock", "importActual", "importMock", "unmock", "doUnmock"])

const noSyncFSInAsyncRule: Rule = {
	meta: {
		name: "no-sync-fs-in-async",
		type: "problem",
		schema: [],
	},
	create(context: RuleContext) {
		/**
		 * Walked here rather than tracked with `:exit` visitors, so the rule owns the traversal and the enclosing-function
		 * state cannot desynchronize from it.
		 */
		function walk(node: AstNode, insideAsync: boolean): void {
			let asyncHere = insideAsync

			if (FUNCTION_NODE_TYPES.has(node.type)) {
				asyncHere = node.async === true
			} else if (SYNC_SCOPE_NODE_TYPES.has(node.type)) {
				asyncHere = false
			}

			if (asyncHere && node.type === "CallExpression" && node.callee?.type === "Identifier") {
				const helper = ASYNC_FILESYSTEM_HELPERS.get(node.callee.name ?? "")

				if (helper) {
					context.report({
						node,
						message:
							`\`${node.callee.name}\` blocks the event loop, and this function is already \`async\` — an ` +
							`\`await\` is legal on this line. Use ${helper}.`,
					})
				}
			}

			for (const [key, value] of Object.entries(node)) {
				if (key === "parent" || key === "range" || key === "loc") continue

				if (Array.isArray(value)) {
					for (const child of value) {
						if (child && typeof child === "object" && typeof (child as AstNode).type === "string") {
							walk(child as AstNode, asyncHere)
						}
					}
				} else if (value && typeof value === "object" && typeof (value as AstNode).type === "string") {
					walk(value as AstNode, asyncHere)
				}
			}
		}

		return {
			Program(node: AstNode) {
				walk(node, false)
			},
		}
	},
}

/**
 * A dynamic `import("./x.ts")` names a file by where the importer sits, so it breaks the moment either side moves and
 * says nothing about which package boundary it crosses. The package's `imports` map (`#eval-harness/promotion-eval`)
 * names the module once, resolves `.ts` under `node` and `out/*.js` everywhere else, and is what a static import of the
 * same module already uses.
 */
const noRelativeDynamicImportRule: Rule = {
	meta: {
		name: "no-relative-dynamic-import",
		type: "suggestion",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			ImportExpression(node: AstNode) {
				const specifier = literalDelimiter(node.source)

				if (specifier === null || !/^\.\.?\//.test(specifier)) return

				context.report({
					node,
					message:
						`import(${stringifyJSON(specifier)}) names a module by the importer's location. Use the package's ` +
						"`imports` map instead (`#<path-from-package-root>`, no extension) — it resolves `.ts` under `node` and " +
						"`out/*.js` everywhere else, and moves with the file.",
				})
			},
		}
	},
}

/**
 * A test file reaches the package under test the way a consumer does — through its public `exports`
 * (`@mailwoman/<pkg>/<subpath>`, `mailwoman/<subpath>`) — and a test helper or an unexported module by relative path,
 * which makes the private dependency visible at the import. `#` specifiers are the package's own `imports` map: legal
 * in `lib/`, where the module names its siblings, and a bypass of the public surface everywhere a test uses one.
 */
const noPrivateImportInTestRule: Rule = {
	meta: {
		name: "no-private-import-in-test",
		type: "suggestion",
		schema: [],
	},
	create(context: RuleContext) {
		const report = (node: AstNode, specifier: string) => {
			context.report({
				node,
				message:
					`${stringifyJSON(specifier)} is the package's private \`imports\` map. A test imports the package under ` +
					"test through its public exports (`@mailwoman/<pkg>/<subpath>`); a module no export names gets an " +
					"`exports` entry, and only a helper under `test/` is imported by relative path.",
			})
		}

		const checkSource = (node: AstNode) => {
			const specifier = literalDelimiter(node.source)

			if (specifier !== null && specifier.startsWith("#")) {
				report(node, specifier)
			}
		}

		return {
			ImportDeclaration: checkSource,
			ExportNamedDeclaration: checkSource,
			ExportAllDeclaration: checkSource,
			ImportExpression: checkSource,
			TSImportType(node: AstNode) {
				const specifier = literalDelimiter(node.argument)

				if (specifier !== null && specifier.startsWith("#")) {
					report(node, specifier)
				}
			},
			CallExpression(node: AstNode) {
				// `vi.mock("#x")`, `vi.doMock`, `vi.importActual`, `vi.importMock`: the specifier is the first argument.
				const callee = node.callee

				if (callee?.type !== "MemberExpression" || callee.object?.name !== "vi") return

				const calleePropertyName = callee.property?.name

				if (!calleePropertyName || !MOCKING_FUNCTIONS.has(calleePropertyName)) {
					return
				}

				const specifier = literalDelimiter(node.arguments?.[0])

				if (specifier !== null && specifier.startsWith("#")) {
					report(node, specifier)
				}
			},
		}
	},
}

/**
 * `fileURLToPath(import.meta.resolve(…))` is string plumbing around a question with a typed answer.
 * `@mailwoman/core/module/resolvers` owns it: `resolveModulePath` for a file a specifier names,
 * `resolvePackageDirectory` for a package's root; a module's own neighbours are `resolvePath(import.meta.dirname, …)`.
 */
const noImportMetaResolveRule: Rule = {
	meta: {
		name: "no-import-meta-resolve",
		type: "suggestion",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			CallExpression(node: AstNode) {
				const callee = node.callee

				if (!callee || (callee.type !== "MemberExpression" && callee.type !== "StaticMemberExpression")) return

				if (callee.property?.type !== "Identifier" || callee.property.name !== "resolve") return

				const object = callee.object

				if (object?.type !== "MetaProperty" || object.meta?.name !== "import" || object.property?.name !== "meta") {
					return
				}

				context.report({
					node,
					message:
						"`import.meta.resolve` answers a `file:` URL string. Use `resolveModulePath(specifier)` or " +
						"`resolvePackageDirectory(name)` from `@mailwoman/core/module/resolvers`, or " +
						"`resolvePath(import.meta.dirname, …)` for a sibling of this module.",
				})
			},
		}
	},
}

/**
 * `resolvePath(import.meta.dirname, "../../x")` names a file by counting directories up from wherever this module sits
 * — a count that changes when the module moves and differs between the source tree and `out/`. A package's own file is
 * `resolvePackagePath("<package>", …)`; a repository file is `repoRootPath(…)`. Descending from the module's own
 * directory (`"fixtures/x.json"`) is not the problem and stays.
 */
const noImportMetaDirnameWalkRule: Rule = {
	meta: {
		name: "no-import-meta-dirname-walk",
		type: "suggestion",
		schema: [],
	},
	create(context: RuleContext) {
		return {
			CallExpression(node: AstNode) {
				const [anchor, segment] = node.arguments ?? []

				if (!anchor || (anchor.type !== "MemberExpression" && anchor.type !== "StaticMemberExpression")) return

				if (anchor.object?.type !== "MetaProperty" || anchor.property?.name !== "dirname") return

				const text = literalDelimiter(segment)

				if (text === null || !text.startsWith("..")) return

				context.report({
					node,
					message:
						`${stringifyJSON(text)} counts directories up from this module. Use ` +
						'`resolvePackagePath("<package>", …)` from `@mailwoman/core/module/resolvers` for a file in this ' +
						"package, or `repoRootPath(…)` from `@mailwoman/core/utils` for a repository file.",
				})
			},
		}
	},
}

/**
 * The method names a call stands on, innermost first: `a.b().c().d()` is `["b", "c", "d"]`. A non-call object (an
 * identifier, a `new` expression, a member read) ends the chain.
 */
function methodChain(node: AstNode): string[] {
	const names: string[] = []
	let current: AstNode | undefined = node

	while (current?.type === "CallExpression") {
		const method = calledMethod(current)

		if (method === null) break
		names.unshift(method)
		current = current.callee?.object
	}

	return names
}

function numericLiteralValue(node: AstNode): number | null {
	if ((node.type === "Literal" || node.type === "NumericLiteral") && typeof node.value === "number") return node.value

	return null
}

/**
 * The base object's name in a computed index read or write — `rows` in `rows[i]`. Null for anything else, including a
 * dotted property (`a.b`), which is not an index.
 */
function indexedBaseName(node: AstNode | undefined): string | null {
	if (node?.type !== "MemberExpression" || node.computed !== true) return null

	return typeof node.object?.name === "string" ? node.object.name : null
}

/**
 * Whether a computed index is a VARIABLE rather than a constant — `xs[i]`, not `xs[0]`.
 *
 * Heapsort's extraction phase counts down from the last index, stops at 1, and swaps two computed indices of one array,
 * so it satisfies every other clause of the shuffle shape. What separates it is that one of its indices is the literal
 * 0: a shuffle swaps the loop variable with a DRAWN index, and neither is a constant.
 */
function isVariableIndex(node: AstNode | undefined): boolean {
	if (node?.type !== "MemberExpression" || node.computed !== true) return false

	return node.property?.type === "Identifier"
}

/**
 * Whether a `for` header counts down from a length to 1: `for (let i = xs.length - 1; i > 0; i--)`, or the same written
 * `i >= 1`.
 *
 * All three clauses are required, and they are not sufficient on their own — heapsort's extraction phase satisfies
 * every one of them. What the body check adds is that both swapped indices are variables; see {@link isVariableIndex}.
 *
 * Known miss: a loop whose bound is hoisted (`const n = xs.length; for (let i = n - 1; …)`) reads as a plain descent
 * and is not reported. Widening the init clause to any identifier would report every backwards loop in the repository,
 * which is a worse trade for a suggestion rule.
 */
function isDescendingFromLength(node: AstNode): boolean {
	const declaration = node.init?.declarations?.[0]?.init

	const fromLength =
		declaration?.type === "BinaryExpression" &&
		declaration.operator === "-" &&
		numericLiteralValue(declaration.right as AstNode) === 1 &&
		declaration.left?.type === "MemberExpression" &&
		declaration.left.property?.name === "length"

	// `i > 0` and `i >= 1` are the same stopping point, and both are written.
	const bound = node.test?.type === "BinaryExpression" ? numericLiteralValue(node.test.right as AstNode) : null

	const toOne = (node.test?.operator === ">" && bound === 0) || (node.test?.operator === ">=" && bound === 1)

	return (
		Boolean(fromLength) && Boolean(toOne) && node.update?.type === "UpdateExpression" && node.update.operator === "--"
	)
}

/**
 * Whether a loop body swaps two computed indices of one array.
 *
 * Two forms, because both are written here: the destructured `[xs[i], xs[j]] = [xs[j], xs[i]]`, and the temporary `tmp
 * = xs[i]; xs[i] = xs[j]; xs[j] = tmp`, which shows up as two index writes to the same base.
 *
 * Reads the body's own statements rather than walking the subtree. A generic walk over an oxlint node's values follows
 * its back-references and never terminates, and depth adds nothing here: a shuffle writes its swap at the top of the
 * loop, so a swap nested inside a branch is a different algorithm.
 */
function swapsTwoIndices(body: AstNode): boolean {
	const statements: AstNode[] = body.type === "BlockStatement" ? ((body.body as AstNode[]) ?? []) : [body]

	const assignments = statements
		.map((statement) => (statement.type === "ExpressionStatement" ? (statement.expression as AstNode) : statement))
		.filter((node): node is AstNode => node?.type === "AssignmentExpression")

	for (const assignment of assignments) {
		const left = assignment.left as AstNode | undefined

		if (left?.type !== "ArrayPattern" && left?.type !== "ArrayExpression") continue

		const elements = (left.elements as AstNode[]) ?? []
		const bases = elements.map((element) => indexedBaseName(element))

		if (bases.length === 2 && bases[0] !== null && bases[0] === bases[1] && elements.every(isVariableIndex)) {
			return true
		}
	}

	const writtenBases = assignments
		.filter((assignment) => isVariableIndex(assignment.left as AstNode))
		.map((assignment) => indexedBaseName(assignment.left as AstNode))
		.filter((name): name is string => name !== null)

	return writtenBases.some((name, index) => writtenBases.indexOf(name) !== index)
}

/**
 * The name a template expression interpolates: the property for `place.locality` and `row["locality"]`, the identifier
 * for a bare `locality`. Anything else answers null, which cannot match a row and so cannot report one.
 */
function interpolatedName(node: AstNode): string | null {
	if (node.type === "Identifier") return node.name ?? null

	if (node.type !== "MemberExpression" && node.type !== "StaticMemberExpression") return null

	if (node.property?.type === "Identifier") return node.property.name ?? null

	return typeof node.property?.value === "string" ? node.property.value : null
}

/**
 * Whether `names` carries every entry of `wanted` in that order, other entries allowed between them. A template that
 * writes a house number before the locality is the same order with an extra component, and the order is what the row
 * names.
 */
function containsInOrder(names: readonly (string | null)[], wanted: readonly string[]): boolean {
	let next = 0

	for (const name of names) {
		if (name === wanted[next]) {
			next++
		}

		if (next === wanted.length) return true
	}

	return false
}

function endsWith(chain: readonly string[], suffix: readonly string[]): boolean {
	if (suffix.length > chain.length) return false

	return suffix.every((name, index) => chain[chain.length - suffix.length + index] === name)
}

function reportStringHome(context: RuleContext, node: AstNode, text: string): void {
	for (const home of HELPER_HOMES) {
		if (home.signature.kind !== "string-literal") continue

		if (!home.signature.includes.some((needle) => text.includes(needle))) continue
		context.report({ node, message: homeMessage(home) })

		return
	}
}

function homeMessage(home: HelperHome): string {
	return (
		`This re-types ${home.reason}, which already has a home: \`${home.symbol}\` from \`${home.specifier}\`. ` +
		"Import it. If this site is the home itself, or the package deliberately carries no dependency on it, " +
		"keep the copy behind a scoped disable stating why."
	)
}

const preferHomeRule: Rule = {
	meta: {
		name: "prefer-home",
		type: "suggestion",
		schema: [],
	},
	create(context: RuleContext) {
		/**
		 * The quasis of tagged templates seen so far. A tagged template is a DSL rather than a string built by hand —
		 * `addr\`${locality} ${region} ${postcode}`` in codex's layout table is the order this rule points people at — and
		 * the walk visits the tag before its quasi, so recording it here is enough to skip it below.
		 */
		const tagged = new WeakSet<object>()

		return {
			TaggedTemplateExpression(node: AstNode) {
				if (node.quasi) {
					tagged.add(node.quasi as object)
				}
			},
			CallExpression(node: AstNode) {
				const chain = methodChain(node)

				if (!chain.length) return

				for (const home of HELPER_HOMES) {
					if (home.signature.kind !== "method-chain" || !endsWith(chain, home.signature.chain)) continue
					const expected = home.signature.arguments

					if (expected) {
						const actual = (node.arguments ?? []).map((argument: AstNode) => numericLiteralValue(argument))

						if (actual.length !== expected.length || expected.some((value, index) => actual[index] !== value)) continue
					}

					context.report({ node, message: homeMessage(home) })

					return
				}
			},
			Literal(node: AstNode) {
				const value = numericLiteralValue(node)

				if (value === null) {
					if (typeof node.value === "string") {
						reportStringHome(context, node, node.value)
					}

					return
				}

				for (const home of HELPER_HOMES) {
					if (home.signature.kind !== "numeric-literal" || !home.signature.values.has(value)) continue
					context.report({ node, message: homeMessage(home) })

					return
				}
			},
			TemplateLiteral(node: AstNode) {
				const text = (node.quasis ?? []).map((quasi) => quasi.value?.cooked ?? "").join(" ")

				reportStringHome(context, node, text)

				if (tagged.has(node as object)) return

				const interpolated = (node.expressions ?? []).map((expression: AstNode) => interpolatedName(expression))

				for (const home of HELPER_HOMES) {
					if (home.signature.kind !== "template-properties") continue

					if (!containsInOrder(interpolated, home.signature.properties)) continue

					context.report({ node, message: homeMessage(home) })

					return
				}
			},
			ForStatement(node: AstNode) {
				if (!isDescendingFromLength(node) || !node.body || !swapsTwoIndices(node.body)) return

				for (const home of HELPER_HOMES) {
					if (home.signature.kind !== "descending-swap-loop") continue
					context.report({ node, message: homeMessage(home) })

					return
				}
			},
		}
	},
}

/**
 * A package re-exporting another workspace package's names (`export { X } from "@mailwoman/core"`, `export * from
 * "@mailwoman/core/resolver"`) gives one declaration two public homes, and a reader can no longer tell from an import
 * which package owns a type. The declaring package is the only public home: a consumer imports `Resolver` from
 * `@mailwoman/core/resolver`, never through `@mailwoman/resolver`. `node:*` and third-party re-exports are not in scope
 * — `@mailwoman/core/fs` re-exporting `node:stream` is the funnel that keeps the builtin out of every other package —
 * and a package's own `#` map is the module naming its siblings, not a foreign name.
 */
const noCrossPackageReexportRule: Rule = {
	meta: {
		name: "no-cross-package-reexport",
		type: "problem",
		schema: [],
	},
	create(context: RuleContext) {
		const check = (node: AstNode): void => {
			const specifier = literalDelimiter(node.source)

			if (specifier === null || !/^(?:@mailwoman\/|mailwoman(?:\/|$))/.test(specifier)) return

			context.report({
				node,
				message:
					`Re-exporting from ${stringifyJSON(specifier)} gives its names a second public home. Consumers import ` +
					"them from the package that declares them; delete the re-export and repoint the importers.",
			})
		}

		return {
			ExportNamedDeclaration(node: AstNode) {
				if (node.source) {
					check(node)
				}
			},
			ExportAllDeclaration(node: AstNode) {
				check(node)
			},
		}
	},
}

const mailwomanPlugin: Plugin = {
	meta: { name: "mailwoman" },
	rules: {
		"no-database-boundary-cast": noDatabaseBoundaryCastRule,
		"no-cross-package-reexport": noCrossPackageReexportRule,
		"no-database-handle-cast": noDatabaseHandleCastRule,
		"no-import-meta-dirname-walk": noImportMetaDirnameWalkRule,
		"no-import-meta-resolve": noImportMetaResolveRule,
		"no-private-import-in-test": noPrivateImportInTestRule,
		"no-relative-dynamic-import": noRelativeDynamicImportRule,
		"no-sync-fs-in-async": noSyncFSInAsyncRule,
		"prefer-home": preferHomeRule,
		"prefer-spliterator": preferSpliteratorRule,
		"require-database-schema-argument": requireDatabaseSchemaArgumentRule,
		"require-disable-reason": requireDisableReasonRule,
	},
}

export default mailwomanPlugin
