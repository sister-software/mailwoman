/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The reference-geocoder clients. `sdk/` means data acquisition in this repo (`ban/sdk`,
 *   `osm/sdk`, `tiger/sdk`, `bdc/sdk`, `filer/sdk`), and that is what these are: two HTTP clients that
 *   fetch someone else's opinion about an address.
 */

// Re-exported so a caller branching on either client's failures needs exactly one import.
//
// HERE RATHER THAN ON EACH CLIENT, which is where `filer/sdk/sec-client.ts` and `bdc/sdk/client.ts`
// put theirs. Those are one client per package, so the convenience re-export cannot collide; this
// package holds two, and `export *` over two modules that both re-export `ResourceError` makes the
// name ambiguous and drops it from the barrel entirely — silently.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

export * from "#sdk/census-client"
export * from "#sdk/census-parser"
export * from "#sdk/census-types"
export * from "#sdk/google-client"
export * from "#sdk/map-link"
export * from "#sdk/google-parser"
export * from "#sdk/google-types"
