/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Repo-local oxlint plugin for Mailwoman.
 *   Loaded with `jsPlugins` in `oxlint.config.ts`.
 *   Repo-specific rules live here.
 *   A generic rule moves to `@sister.software/oxlint-config`.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { AstNode } from "@sister.software/oxlint-config/plugin-types"

import { reflowRule } from "./config/oxlint/comment-reflow/rule.ts"
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
 * Delimiters this rule handles, mapped to suggested spliterators.
 */
const DELIMITER_HINTS = new Map<string, { rendered: string; hints: string[] }>([
	[
		"\n",
		{ rendered: String.raw`"\n"`, hints: ["TextSpliterator", "CSVSpliterator", "TSVSpliterator", "JSONSpliterator"] },
	],
	["\t", { rendered: String.raw`"\t"`, hints: ["TSVSpliterator"] }],
])

/**
 * Returns the delimiter string of a plain literal or template.
 * Any other argument returns null.
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
 * Kysely boundary methods validated against schema.
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
 * True if an expression contains a cast to `never`.
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
 * Returns the called member name for non-computed member calls.
 */
function calledMethod(node: AstNode): string | null {
	const callee = node.callee

	if (!callee || (callee.type !== "MemberExpression" && callee.type !== "StaticMemberExpression")) return null

	return callee.property?.type === "Identifier" ? (callee.property.name ?? null) : null
}

/**
 * Handle types that carry database schema information.
 */
const DATABASE_HANDLE_TYPES = new Set(["DatabaseClient", "Kysely", "Transaction"])

/**
 * Returns the cast target name for plain type references.
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
						'| "selectFrom">`) and the caller passes its own handle with no cast at all; `layerschemahandle` ' +
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
 * Sync `node:fs` methods mapped to async helper replacements.
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
 * Nodes that reset async scope because their contents run synchronously.
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
		 * Manual traversal keeps async-scope tracking in one place.
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
 * Disallow relative dynamic imports.
 * Use package `imports` aliases instead.
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
 * Disallow private `#` import-map specifiers in tests.
 *
 * Tests should use public exports or explicit relative helpers.
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
				// Vitest mock helpers take the module specifier as the first argument.
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
 * Disallow `import.meta.resolve`.
 * Prefer typed helpers in `@mailwoman/core/module/resolvers`.
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
 * Disallow walking upward from `import.meta.dirname` with `..` segments.
 * Prefer `resolvePackagePath` or `repoRootPath`.
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
 * Returns method names for a call chain, inner to outer.
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
 * Returns base identifier for computed index access (e.g. `rows` in `rows[i]`).
 */
function indexedBaseName(node: AstNode | undefined): string | null {
	if (node?.type !== "MemberExpression" || node.computed !== true) return null

	return typeof node.object?.name === "string" ? node.object.name : null
}

/**
 * True for variable computed indices (`xs[i]`), false for constants (`xs[0]`).
 */
function isVariableIndex(node: AstNode | undefined): boolean {
	if (node?.type !== "MemberExpression" || node.computed !== true) return false

	return node.property?.type === "Identifier"
}

/**
 * True for loops descending from `xs.length - 1` to `1`/`0` with `i--`.
 */
function isDescendingFromLength(node: AstNode): boolean {
	const declaration = node.init?.declarations?.[0]?.init

	const fromLength =
		declaration?.type === "BinaryExpression" &&
		declaration.operator === "-" &&
		numericLiteralValue(declaration.right as AstNode) === 1 &&
		declaration.left?.type === "MemberExpression" &&
		declaration.left.property?.name === "length"

	// `i > 0` and `i >= 1` are equivalent stop conditions.
	const bound = node.test?.type === "BinaryExpression" ? numericLiteralValue(node.test.right as AstNode) : null

	const toOne = (node.test?.operator === ">" && bound === 0) || (node.test?.operator === ">=" && bound === 1)

	return (
		Boolean(fromLength) && Boolean(toOne) && node.update?.type === "UpdateExpression" && node.update.operator === "--"
	)
}

/**
 * True if the loop body swaps two computed indices of one array.
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
 * Returns interpolated identifier/property name, or null.
 */
function interpolatedName(node: AstNode): string | null {
	if (node.type === "Identifier") return node.name ?? null

	if (node.type !== "MemberExpression" && node.type !== "StaticMemberExpression") return null

	if (node.property?.type === "Identifier") return node.property.name ?? null

	return typeof node.property?.value === "string" ? node.property.value : null
}

/**
 * True if `names` contains all `wanted` entries in order.
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
		 * Track tagged template quasis so plain-template checks can skip them.
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
 * Disallow re-exporting symbols from other workspace packages.
 * Keep one public source package for each declaration.
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
		// This rule supports fixes and is typed against `@oxlint/plugins`.
		// Cast to the local `Rule` shape for this table.
		"comment-reflow": reflowRule as unknown as Rule,
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
