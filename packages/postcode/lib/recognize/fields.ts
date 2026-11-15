// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The types of the `knownFormats` field the `postcode_legacy` family returns,
 *   derived from the legacy-formats table.
 */

import type { KnownFormatHit } from "@mailwoman/recognize/types"

import type { LEGACY_FORMATS, PO_BOX } from "#legacy-formats/table"

/**
 * The name of a known format: each legacy postcode format and the PO box.
 *
 * The union comes from the table, so a row added there joins it here.
 */
export type KnownFormat = (typeof LEGACY_FORMATS)[number]["format"] | (typeof PO_BOX)["format"]

/**
 * The fields the `postcode_legacy` family adds to a recognition result.
 *
 * Offsets are UTF-16 code units, and the order is the order of `detectKnownFormats`
 * of `@mailwoman/query-shape`.
 */
export interface PostcodeLegacyFields {
	readonly knownFormats: ReadonlyArray<KnownFormatHit<KnownFormat>>
}

/**
 * Whether a known-format name is a postcode format.
 *
 * The check uses the naming convention `us_zip`, `us_zip4` or `<cc>_postcode` instead of a set,
 * so a row added to the table becomes a postcode once it follows the convention.
 * A test checks every row of the table against this function.
 */
export function isKnownPostcodeFormat(format: string): boolean {
	return format === "us_zip" || format === "us_zip4" || format.endsWith("_postcode")
}
