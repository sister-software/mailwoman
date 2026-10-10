// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Default schema type for {@link DatabaseClient}; consumers supply their own table schema.
 */

/**
 * Empty schema marker used only as the generic default.
 */
export type Database = Record<string, never>

/**
 * A `meta` table of key-value pairs: provenance, license and build statistics stored
 * with the database rather than in a document that can drift from it.
 *
 * Its keys are specific to the builder.
 */
export interface KeyValueMetaTable {
	key: string
	value: string | null
}
