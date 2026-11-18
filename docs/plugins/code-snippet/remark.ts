// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fills a fenced code block from the snippet file its info string points at.
 *
 *   A page writes an empty fence such as ` ```ts file=./start.snippet.mts `, and the build replaces its
 *   content with the file's text. The snippet file is the only copy of the example. oxlint lints it,
 *   `yarn compile` type-checks it against the workspace packages, and a release smoke test can run it.
 *
 *   A path resolves against the page's directory.
 *   A missing file, and a fence that holds text of its own beside a `file=` attribute,
 *   fail the build, so a page never shows a second copy that can drift.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { dirname, resolvePath } from "path-ts"
import type { Node } from "unist"
import { visit } from "unist-util-visit"

interface CodeNode extends Node {
	type: "code"
	meta?: string | null
	value: string
}

/**
 * The `file=<path>` attribute of a fence's info string.
 */
const FILE_ATTRIBUTE = /(?:^|\s)file=(\S+)/

function isCodeNode(node: Node): node is CodeNode {
	return node.type === "code"
}

/**
 * Returns a fence's snippet path and its info string without the attribute,
 * or `null` for a fence without one.
 */
export function snippetReference(meta: string | null | undefined): { path: string; meta: string | null } | null {
	const match = FILE_ATTRIBUTE.exec(meta ?? "")

	if (!match) return null

	const rest = meta!.replace(FILE_ATTRIBUTE, "").trim()

	return { path: match[1]!, meta: rest || null }
}

/**
 * The remark plugin that fills each `file=` fence from its snippet file.
 */
export default function remarkCodeSnippet() {
	return async (tree: Node, file: { path?: string }) => {
		const fences: Array<{ node: CodeNode; path: string; meta: string | null }> = []

		visit(tree, isCodeNode, (node: CodeNode) => {
			const reference = snippetReference(node.meta)

			if (reference) {
				fences.push({ node, ...reference })
			}
		})

		for (const { node, path, meta } of fences) {
			if (!file.path) throw new Error(`a fence includes ${path}, and the page has no path to resolve it against`)

			if (node.value.trim()) {
				throw new Error(
					`${file.path}: the fence that includes ${path} holds text of its own; the file is the only copy`
				)
			}

			const text = await readLocalTextFile(resolvePath(dirname(file.path), path))

			node.value = text.replace(/\n$/, "")
			node.meta = meta
		}
	}
}
