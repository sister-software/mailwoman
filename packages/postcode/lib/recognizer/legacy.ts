// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   LEGACY-QUERY-SHAPE: delete this module, its generated artifact and `legacy-formats/table.ts`
 *   when the first model that declares `requires.query_shape: "postal"` ships.
 *
 *   The `postcode_legacy` family: the postcode and PO box formats `@mailwoman/query-shape`
 *   reports as `knownFormats`, as a family of `@mailwoman/recognizer`.
 *
 *   Compose it with the `structure` family.
 *   The result's `fields.knownFormats` is a list of `{ format, span, confidence }` in
 *   the order of the pipeline's legacy detector, with UTF-16 offsets.
 *
 *   The family reports no recognitions of its own, and a recognizer that composes it
 *   without `structure` throws a `RecognizeCompositionError` at construction.
 *
 *   ```ts
 *   import { createRecognizer } from "@mailwoman/recognizer"
 *   import { structure } from "@mailwoman/recognizer/structure"
 *   import { postcodeLegacy } from "@mailwoman/postcode/recognizer/legacy"
 *
 *   const { fields } = createRecognizer([structure, postcodeLegacy]).recognize("SW1A 1AA")
 *   ```
 *
 *   The patterns are the thirteen legacy patterns, so the hit set equals the legacy one.
 *   The table is `legacy-formats/table.ts`, and `tools/generate.run.ts` compiles it.
 *
 *   This module imports its own artifact only.
 *   A bundle that imports it holds no byte of the `postal` family.
 *
 *   That family has its own module, `@mailwoman/postcode/recognizer/postal`.
 */

export { postcodeLegacy, POSTCODE_LEGACY_FAMILY_ID } from "#recognizer/postcode_legacy.generated"
export { type KnownFormat, type PostcodeLegacyFields } from "#recognizer/fields"
