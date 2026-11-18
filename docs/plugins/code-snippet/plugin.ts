// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Publishes snippet files' text as global data for TSX pages.
 *
 *   Remark processes Markdown and MDX only, so a TSX page reads a snippet from this plugin.
 *   `docs/src/hooks/snippet.ts` returns one by name.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

export interface CodeSnippetPluginOptions {
	/**
	 * Each snippet's name, mapped to its path relative to the docs workspace.
	 */
	snippets: Record<string, string>
}

export default function codeSnippetPlugin(
	context: LoadContext,
	options: CodeSnippetPluginOptions
): Plugin<Record<string, string>> {
	return {
		name: "code-snippet",
		async loadContent() {
			const texts: Record<string, string> = {}

			for (const [name, path] of Object.entries(options.snippets)) {
				texts[name] = (await readLocalTextFile(resolvePath(context.siteDir, path))).replace(/\n$/, "")
			}

			return texts
		},
		getPathsToWatch() {
			return Object.values(options.snippets).map((path) => resolvePath(context.siteDir, path).toString())
		},
		contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},
	}
}
