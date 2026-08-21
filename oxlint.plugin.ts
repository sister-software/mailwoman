/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Mailwoman's repo-local oxlint JS plugin (ESLint v9-compatible API), loaded alongside the
 *   bundled Sister Software plugin via `jsPlugins` in `oxlint.config.ts`. Rules encoding
 *   mailwoman-specific guidance live here; anything general enough for other repos graduates to
 *   `@sister.software/oxlint-config`.
 *
 *   `prefer-spliterator`: `text.split("\n")` (or `"\t"`) materializes every segment into one array
 *   before the first is read — the whole-buffer parse the spliterator library exists to avoid (the
 *   quadratic-CSV episode in AGENTS.md started exactly there). The rule warns on those two literal
 *   delimiters only; splitting on anything else is not a streaming shape and stays silent.
 */

// The plugin-type declarations below mirror `@sister.software/oxlint-config`'s internal
// `plugin-types.ts`, which the package deliberately does not export. Only the fields this rule
// reads are declared.

interface AstNode {
	type: string
	range: [number, number]
	value?: unknown
	name?: string
	callee?: AstNode
	object?: AstNode
	property?: AstNode
	arguments?: AstNode[]
	expression?: AstNode
	typeAnnotation?: AstNode
	quasis?: { value?: { cooked?: string } }[]
	expressions?: AstNode[]
}

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

const mailwomanPlugin: Plugin = {
	meta: { name: "mailwoman" },
	rules: {
		"no-database-boundary-cast": noDatabaseBoundaryCastRule,
		"no-database-handle-cast": noDatabaseHandleCastRule,
		"prefer-spliterator": preferSpliteratorRule,
		"require-database-schema-argument": requireDatabaseSchemaArgumentRule,
		"require-disable-reason": requireDisableReasonRule,
	},
}

export default mailwomanPlugin
