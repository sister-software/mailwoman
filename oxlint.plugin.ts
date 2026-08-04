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
	property?: AstNode
	arguments?: AstNode[]
	quasis?: { value?: { cooked?: string } }[]
	expressions?: AstNode[]
}

interface RuleContext {
	options: unknown[]
	report(descriptor: { node: unknown; message: string }): void
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
						`spliterator's ${entry.hints.map((h) => `\`${h}\``).join(", ")}. Each spliterator has synchronous and asynchronous helpers. Prefer the async variant when possible.\nIf the input is small and bounded (and will not grow in the future), keep split behind a scoped disable stating why.`,
				})
			},
		}
	},
}

const mailwomanPlugin: Plugin = {
	meta: { name: "mailwoman" },
	rules: {
		"prefer-spliterator": preferSpliteratorRule,
	},
}

export default mailwomanPlugin
