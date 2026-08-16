// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Ordnance Survey Code-Point Open acquisition — fetch → extract → parse, the `ban/sdk` shape. See
 *   `./fetch.ts` for the licence obligation and for why this lives here rather than in its own
 *   workspace.
 */

export * from "./extract.ts"
export * from "./fetch.ts"
export * from "./parse.ts"
