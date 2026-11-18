// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { usePluginData } from "@docusaurus/useGlobalData"

/**
 * Returns the current release version that `docs/plugins/release-version/plugin.ts` publishes.
 *
 * @throws When the plugin isn't registered, so a page never renders an empty version.
 */
export function useReleaseVersion(): string {
	const data = usePluginData("release-version") as { version?: unknown } | undefined

	if (typeof data?.version !== "string") {
		throw new TypeError("The release-version plugin published no version")
	}

	return data.version
}
