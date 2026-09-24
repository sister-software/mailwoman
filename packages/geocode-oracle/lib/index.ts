/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Private reference-geocoder clients for authoring gauntlet cases.
 *   Kept separate from the published `mailwoman` runtime because Google requests may be billed and require the
 *   operator's key. The clients return normalized addresses and untouched provider responses for comparison with
 *   manually authored expectations.
 *
 *   These providers are not ground truth and must not determine release decisions. Results can disagree with each
 *   other or with the address. A human reviews them before changing an expectation.
 *
 * @example
 *
 * ```ts
 * import { createGoogleGeocoderClient } from "@mailwoman/geocode-oracle/sdk"
 *
 * await using google = createGoogleGeocoderClient()
 * const [best] = await google.geocodeAddress("181 Rue du Chevaleret, 75013 Paris", { country: "FR" })
 *
 * console.log(best?.address.components, best?.address.geocode?.tier)
 * ```
 */

export * from "#result"
export * from "#sdk/index"
