// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Returns the module an artifact's bytes live in under `lib/artifacts/`, grouped by the dataset it reads.
 */
export function artifactModulePath(name: string): string {
	return name.replace(/^(iso3166-1|iata-airport)-/u, "$1/")
}
