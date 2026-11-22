// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The operator's `--exclude-licenses` spec, read into the patterns `licenseVerdict` in
 *   `@mailwoman/license/policy` matches.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"

/**
 * Compile an `--exclude-licenses` spec (comma-separated, e.g. `"ODbL,CC-BY-SA"`) into anchored,
 * case-insensitive prefix patterns, so `CC-BY-SA` catches `CC-BY-SA-3.0`.
 *
 * The spec is a literal license prefix the operator typed.
 * Regex metacharacters are escaped.
 *
 * This is the one place a prefix match is the right reading, because the operator
 * is naming a spelling rather than asking about an obligation.
 */
export function compileLicenseExcludes(spec: string): RegExp[] {
	return extractDelimited(spec).map((s) => new RegExp("^" + escapeRegExp(s), "i"))
}
