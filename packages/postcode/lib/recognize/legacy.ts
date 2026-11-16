// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `postcode_legacy` family: the postcode and PO box formats `@mailwoman/query-shape`
 *   reports as `knownFormats`, as a family of `@mailwoman/recognize`.
 *
 *   Compose it with the `structure` family.
 *   The result's `fields.knownFormats` is a list of `{ format, span, confidence }` in
 *   the order of the pipeline's legacy detector, with UTF-16 offsets.
 *
 *   The family reports no recognitions of its own, and a recognizer that composes it
 *   without `structure` throws a `RecognizeCompositionError` at construction.
 *
 *   ```ts
 *   import { createRecognizer } from "@mailwoman/recognize"
 *   import { structure } from "@mailwoman/recognize/structure"
 *   import { postcodeLegacy } from "@mailwoman/postcode/recognize/legacy"
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
 *   That family has its own module, `@mailwoman/postcode/recognize/postal`.
 */

export { postcodeLegacy, POSTCODE_LEGACY_FAMILY_ID } from "#recognize/postcode_legacy.generated"
export { type KnownFormat, type PostcodeLegacyFields } from "#recognize/fields"
