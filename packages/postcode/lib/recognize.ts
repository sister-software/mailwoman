// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The families this package owns, as families of `@mailwoman/recognize`.
 *
 *   # `postcodeLegacy`
 *
 *   The postcode and PO box formats `@mailwoman/query-shape` reports as `knownFormats`.
 *   Compose it with the `structure` family.
 *
 *   The result's `fields.knownFormats` is a list of `{ format, span, confidence }`
 *   in the order `detectKnownFormats` returns, with UTF-16 offsets.
 *
 *   The family reports no recognitions of its own, and a recognizer that composes it
 *   without `structure` throws a `RecognizeCompositionError` at construction.
 *
 *   ```ts
 *   import { createRecognizer } from "@mailwoman/recognize"
 *   import { structure } from "@mailwoman/recognize/structure"
 *   import { postcodeLegacy } from "@mailwoman/postcode/recognize"
 *
 *   const { fields } = createRecognizer([structure, postcodeLegacy]).recognize("SW1A 1AA")
 *   ```
 *
 *   The patterns are the thirteen legacy patterns, so the hit set equals the legacy one.
 *   The table is `legacy-formats/table.ts`, and `tools/generate.run.ts` compiles it.
 *
 *   # `postal`
 *
 *   A recognition of this family reports that a string has the form of a postcode
 *   in some countries: the syntax of every country `postcodeSyntaxCountries` lists,
 *   as one shape for each distinct language.
 *   It is syntax only: it leaves open whether a code is allocated, and PCB1
 *   and PFX1 membership stay with the dictionary readers.
 *
 *   ```ts
 *   import { createRecognizer } from "@mailwoman/recognize"
 *   import { postal, postalCandidates } from "@mailwoman/postcode/recognize"
 *
 *   const text = "12345 Main Street"
 *   const candidates = postalCandidates(createRecognizer([postal]).recognize(text).recognitions)
 *   ```
 *
 *   `postalCountries` returns the countries a recognition accepts,
 *   `acceptingCountries` is the whole-input form that equals `countriesAcceptingPostcode`,
 *   and `postalCandidates` lists the candidates of a result.
 *   The engine applies the boundary rule for a code inside an address.
 *   `lib/recognize/postal.ts` states the rule.
 */

export { postcodeLegacy, POSTCODE_LEGACY_FAMILY_ID } from "#recognize/postcode_legacy.generated"
export { isKnownPostcodeFormat, type KnownFormat, type PostcodeLegacyFields } from "#recognize/fields"
export { postal, POSTAL_FAMILY_ID, PostalKind } from "#recognize/postal.generated"

export {
	acceptingCountries,
	isPostalRecognition,
	postalCandidates,
	postalCountries,
	postalCountryCodes,
	splitPrintedPostcode,
	type PostalCandidate,
	type PostalRecognitionLike,
	type PostalRecognizerLike,
	type PrintedPostcode,
} from "#recognize/postal"
