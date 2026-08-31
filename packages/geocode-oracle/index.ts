/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `@mailwoman/geocode-oracle` — third-party reference geocoders as a VERIFICATION ORACLE.
 *
 *   WHY THIS IS ITS OWN, PRIVATE WORKSPACE. The consumer is gauntlet-case authoring, and the gauntlet
 *   lives in `mailwoman/eval-harness/gauntlet/` — inside `mailwoman`, the published entry package
 *   every user installs. Putting a billed third-party geocoder there would put it on that package's
 *   runtime path. No existing workspace is a better home either: `registry`, `filer`, `corpus` and
 *   `tiger` are all published, and this package's dependency fan (`core`, `spatial`, `formatter`,
 *   `record`, `address-id`, `codex`, `tiger`) would have to be pushed ONTO whichever one adopted it —
 *   the wrong direction. As its own workspace it depends on all seven and nothing depends on it, which
 *   is the property that actually matters.
 *
 *   `bdc` and `filer` are the precedent for the shape: one external HTTP data source, one workspace,
 *   the client under `sdk/`. The difference is `"private": true` — this is operator tooling that needs
 *   the operator's own billed Google key and can do nothing useful for a consumer, and privacy also
 *   zeroes the publish-surface cost (no `publishConfig.exports` derivation, no `.release-it.json`
 *   entry, no tarball exports guard, no npm 2FA round). What it still pays is the compile-time cost
 *   every placement would pay: a dev `exports` map, a tsconfig pair, and two root `tsconfig.json`
 *   references.
 *
 *   WHAT IT IS FOR. A gauntlet `SeedCase` pins `expectComponents`, `expectLat`/`expectLon`,
 *   `expectToleranceM` and `expectTier` by hand, and today those numbers come from whoever fixed the
 *   bug. This gives that person a second opinion in the SAME vocabulary — the clients answer with
 *   `@mailwoman/record`'s `PostalAddress` (a `ComponentTag`-keyed dict, the formatter's `canonicalKey`,
 *   a coordinate and a `ResolutionTier`), so the comparison is field-to-field rather than eyeball.
 *
 *   WHAT IT IS NOT. Not truth, and not a gate. Google and the Census Bureau disagree with each other
 *   and with the address as written, and both return a confident coordinate for addresses that do not
 *   exist. Nothing here should ever decide whether a build ships; a human reads it and decides what to
 *   pin. `OracleGeocodeResult.raw` always carries the provider's untouched answer for exactly that
 *   reading.
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
