// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Thin re-export of `@mailwoman/formatter`.
 *
 *   The formatter implementation moved to its own workspace (`@mailwoman/formatter`) so the parser,
 *   the corpus pipeline, and the record matcher can share one locale-aware renderer plus the
 *   canonical match key. This module stays put as the stable `@mailwoman/corpus/format` entry point
 *   the synthesis adapters import `formatAddress` / `reconcileComponents` from.
 */

export * from "@mailwoman/formatter"
