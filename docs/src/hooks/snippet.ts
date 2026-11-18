// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { usePluginData } from "@docusaurus/useGlobalData"

/**
 * Returns the text of the snippet `docs/plugins/code-snippet/plugin.ts` publishes under `name`.
 *
 * @throws When the plugin publishes no snippet by that name, so a page never renders an empty code block.
 */
export function useCodeSnippet(name: string): string {
	const data = usePluginData("code-snippet") as Record<string, unknown> | undefined
	const text = data?.[name]

	if (typeof text !== "string") {
		throw new TypeError(`The code-snippet plugin published no snippet named ${name}`)
	}

	return text
}
