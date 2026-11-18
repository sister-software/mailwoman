// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Replaces `{{release.<key>}}` tokens in fenced and inline code with the current release values.
 *
 *   An install or run instruction writes `npm install mailwoman@{{release.version}}`,
 *   and the built page shows the version the `mailwoman` manifest declares.
 *   MDX evaluates braces in prose as expressions, so the tokens work only inside code.
 *   The instructions are in code blocks.
 *
 *   A sentence that records a check against a specific release keeps its literal version,
 *   because the check ran against that version and no other.
 */

import type { Node } from "unist"
import { visit } from "unist-util-visit"

import { readReleaseValues, type ReleaseValues } from "./version.ts"

interface CodeNode extends Node {
	type: "code" | "inlineCode"
	value: string
}

const RELEASE_TOKEN = /\{\{\s*release\.([A-Za-z]+)\s*\}\}/g

function isCodeNode(node: Node): node is CodeNode {
	return node.type === "code" || node.type === "inlineCode"
}

/**
 * Replaces every release token in `text`.
 *
 * @param source The file the text came from, quoted in the error.
 * @throws When a token refers to a key that {@linkcode ReleaseValues} doesn't define,
 * so a page never renders a raw placeholder.
 */
export function substituteReleaseTokens(text: string, values: ReleaseValues, source = "<unknown file>"): string {
	return text.replaceAll(RELEASE_TOKEN, (token, key: string) => {
		if (!Object.hasOwn(values, key)) {
			const known = Object.keys(values).join(", ")

			throw new Error(`${source}: ${token} refers to no release value. Known keys: ${known}`)
		}

		return values[key as keyof ReleaseValues]
	})
}

/**
 * The remark plugin that substitutes release tokens in `code` and `inlineCode` nodes.
 */
export default function remarkReleaseVersion() {
	return async (tree: Node, file: { path?: string }) => {
		const values = await readReleaseValues()

		visit(tree, isCodeNode, (node: CodeNode) => {
			node.value = substituteReleaseTokens(node.value, values, file.path)
		})
	}
}
