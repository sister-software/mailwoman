// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family: its compiled artifact and the structural fields it adds to a result.
 *
 *   Import `structure` and pass it to `createRecognizer`.
 *   The result's `fields` then hold `characterClass`, `scripts`, `tokenClasses`,
 *   `segments`, `regionAbbreviations` and `totalLength`, equal to what
 *   `computeQueryShape` of `@mailwoman/query-shape` returns.
 *   The family reports no recognitions.
 *
 *   The declarations are generated, and this module is their public path.
 */

export * from "#structure.generated"
