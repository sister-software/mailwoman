// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/formatter` — the inverse of the parser.
 *
 *   - {@linkcode formatAddress} / {@linkcode formatFromClassificationMap}: components → idiomatic,
 *       locale-aware address string (for display and corpus synthesis).
 *   - {@linkcode canonicalKey}: components → a normalized, deterministic match key (for the matcher's
 *       blocking stage).
 */

export * from "./format.ts"
export * from "./key.ts"
