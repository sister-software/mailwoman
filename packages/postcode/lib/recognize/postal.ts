// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `postal` family: the form of a postcode in every country `postcodeSyntaxCountries` lists,
 *   as one shape for each distinct language, with its kinds and the readers of its recognitions.
 *
 *   A recognition of this family reports that a string has the form of a postcode in some countries.
 *   It leaves open whether a code is allocated, and PCB1 and PFX1 membership
 *   stay with the dictionary readers.
 *
 *   ```ts
 *   import { createRecognizer } from "@mailwoman/recognize"
 *   import { postal, postalCandidates } from "@mailwoman/postcode/recognize/postal"
 *
 *   const text = "12345 Main Street"
 *   const candidates = postalCandidates(createRecognizer([postal]).recognize(text).recognitions)
 *   ```
 *
 *   `postalCountries` returns the countries a recognition accepts,
 *   `acceptingCountries` is the whole-input form that equals `countriesAcceptingPostcode`,
 *   and `postalCandidates` lists the candidates of a result.
 *   `postal/readers.ts` states the boundary rule for a code inside an address.
 *
 *   The `postcode_legacy` family has its own module, `@mailwoman/postcode/recognize/legacy`.
 *   This module imports its own artifact only, so a bundle that imports it
 *   holds no byte of the legacy artifact.
 */

export { postal, POSTAL_FAMILY_ID, PostalKind } from "#recognize/postal.generated"

export {
	acceptingCountries,
	disjointSpans,
	isPostalRecognition,
	postalCandidates,
	postalCountries,
	postalCountryCodes,
	postalKindsOfCountry,
	postalSpans,
	splitPrintedPostcode,
	type PostalCandidate,
	type PostalForm,
	type PostalSpan,
	type PostalKindsOfCountry,
	type PostalRecognitionLike,
	type PostalRecognizerLike,
	type PrintedPostcode,
} from "#recognize/postal/readers"
