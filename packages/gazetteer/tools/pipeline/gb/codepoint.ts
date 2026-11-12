// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ordnance Survey Code-Point Open acquisition — fetch → extract, the `ban/sdk` shape.
 *
 *   See `./fetch.ts` for the license obligation and for why this lives here
 *   rather than in its own workspace.
 *   The CSV reader is `@mailwoman/spatial/gb/codepoint`, which the corpus adapters share.
 */

export * from "#tools/pipeline/gb/codepoint/extract"
export * from "#tools/pipeline/gb/codepoint/fetch"
