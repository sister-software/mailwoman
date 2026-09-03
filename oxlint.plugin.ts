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
 *   where an `await` is already legal on the same line. The rule fires ONLY in that position — a sync call inside a
 *   sync function is a cascade, not a defect, and the rule stays silent there.
 *
 *   `no-relative-dynamic-import`: `import("./x.ts")` names a module by the importer's location; the package's
 *   `imports` map names it once.
 *
 *   `no-import-meta-dirname-walk`: `resolvePath(import.meta.dirname, "../..")` counts directories; a package's own
 *   file is `resolvePackagePath`, a repository file is `repoRootPath`.
 *
 *   `no-import-meta-resolve`: `fileURLToPath(import.meta.resolve(…))` has a typed home in
 *   `@mailwoman/core/module/resolvers`.
 *
 *   `prefer-spliterator`: `text.split("\n")` (or `"\t"`) materializes every segment into one array
 *   before the first is read — the whole-buffer parse the spliterator library exists to avoid (the
 *   quadratic-CSV episode in AGENTS.md started exactly there). The rule warns on those two literal
 *   delimiters only; splitting on anything else is not a streaming shape and stays silent.
 */

import type { AstNode } from "@sister.software/oxlint-config/plugin-types"

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
	["readdirSync", "`readDirectory(path)` or `readDirectoryEntries(path)` (@mailwoman/core/fs/readers)"],
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
						`import(${JSON.stringify(specifier)}) names a module by the importer's location. Use the package's ` +
						"`imports` map instead (`#<path-from-package-root>`, no extension) — it resolves `.ts` under `node` and " +
						"`out/*.js` everywhere else, and moves with the file.",
				})
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
						`${JSON.stringify(text)} counts directories up from this module. Use ` +
						'`resolvePackagePath("<package>", …)` from `@mailwoman/core/module/resolvers` for a file in this ' +
						"package, or `repoRootPath(…)` from `@mailwoman/core/utils` for a repository file.",
				})
			},
		}
	},
}

const mailwomanPlugin: Plugin = {
	meta: { name: "mailwoman" },
	rules: {
		"no-database-boundary-cast": noDatabaseBoundaryCastRule,
		"no-database-handle-cast": noDatabaseHandleCastRule,
		"no-import-meta-dirname-walk": noImportMetaDirnameWalkRule,
		"no-import-meta-resolve": noImportMetaResolveRule,
		"no-relative-dynamic-import": noRelativeDynamicImportRule,
		"no-sync-fs-in-async": noSyncFSInAsyncRule,
		"prefer-spliterator": preferSpliteratorRule,
		"require-database-schema-argument": requireDatabaseSchemaArgumentRule,
		"require-disable-reason": requireDisableReasonRule,
	},
}

export default mailwomanPlugin
