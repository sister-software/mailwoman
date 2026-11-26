// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

/**
 * The committed path of one release-requirement specification version.
 *
 * Resolved from the package root because `tsc` doesn't emit `.json` specs into `out/`.
 */
export function releaseSpecPath(version: string | number): string {
	return resolvePackagePath(
		"mailwoman",
		"tools",
		"eval-harness",
		"release",
		"specs",
		`release-requirements.v${version}.json`
	)
}

/**
 * The committed release-requirement specification that release eligibility
 * and the coverage funnel read when no other specification is listed.
 *
 * A new specification version moves this path in the same change.
 */
export const CURRENT_RELEASE_SPEC: string = releaseSpecPath(17)
