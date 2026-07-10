// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Core operator tools — the `run()`-style modules behind `mailwoman dev generate …` commands. No
 *   argv, no `process.exit`: commands own parsing, rendering, and exit codes (see the 2026-07-09
 *   scripts→Pastel spec).
 */

export * from "./download-libpostal-resources.ts"
export * from "./download-ssl-address.ts"
export * from "./generate-language-types.ts"
