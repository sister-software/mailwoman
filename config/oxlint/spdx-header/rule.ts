// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The `mailwoman/spdx-header` rule: a file starts with the SPDX header, then one blank line.
 *
 * The rule and the `spdx-header` repository check both decide through `@mailwoman/core/spdx-header`.
 * The fix rewrites the file with the same function the sweep tool used.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { rewriteSourceHeader, sourceHeaderProblem, sourceHeaderSyntax } from "@mailwoman/core/spdx-header"
import type { CreateRule } from "@oxlint/plugins"

/**
 * The repository-relative path oxlint is linting, so the exempt list matches on the same paths git lists.
 */
function repositoryPath(filename: string): string {
	const root = `${repoRootPath()}/`

	return filename.startsWith(root) ? filename.slice(root.length) : filename
}

/**
 * Registered as `mailwoman/spdx-header` by `oxlint.plugin.ts`.
 */
export const spdxHeaderRule: CreateRule = {
	meta: {
		type: "layout",
		docs: {
			description: "Require the SPDX header as a file's first lines, followed by a blank line.",
			recommended: true,
		},
		fixable: "code",
		schema: [],
		messages: { header: "{{problem}}" },
	},
	create(context) {
		return {
			Program(node) {
				const syntax = sourceHeaderSyntax(repositoryPath(context.filename))

				if (syntax == null) return

				const text = context.sourceCode.text
				const comments = context.sourceCode.getAllComments().map((comment) => comment.range)
				const problem = sourceHeaderProblem(text, syntax, comments)

				if (problem == null) return

				context.report({
					node,
					loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
					messageId: "header",
					data: { problem },
					fix: (fixer) => fixer.replaceTextRange([0, text.length], rewriteSourceHeader(text, syntax, comments)),
				})
			},
		}
	},
}
