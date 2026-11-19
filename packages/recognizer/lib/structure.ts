// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family: its compiled artifact and the structural fields it adds to a result.
 *
 *   Import `structure` and pass it to `createRecognizer`.
 *   The result's `fields` then hold `characterClass`, `scripts`, `tokenClasses`,
 *   `segments`, `regionAbbreviations` and `totalLength`.
 *
 *   The fields equal the output of the legacy classifier that the parse pipeline read
 *   before this package replaced it.
 *   `data/fixtures/query-shape-frozen.fixture.json` records that output.
 *   The family reports no recognitions.
 *
 *   The declarations are generated, and this module is their public path.
 */

export * from "#structure.generated"
