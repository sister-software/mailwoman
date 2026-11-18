// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Publishes the release values as global data for TSX pages.
 *
 *   Remark processes Markdown and MDX only, so a TSX page reads the values from this plugin.
 *
 *   `docs/src/hooks/release.ts` reads them with `usePluginData`.
 */

import type { Plugin } from "@docusaurus/types"

import { readReleaseValues, type ReleaseValues } from "./version.ts"

export default function releaseVersionPlugin(): Plugin<ReleaseValues> {
	return {
		name: "release-version",
		loadContent: () => readReleaseValues(),
		contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},
	}
}
