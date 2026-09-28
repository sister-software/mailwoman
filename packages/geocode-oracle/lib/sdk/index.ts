/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The reference-geocoder clients. `sdk/` means data acquisition in this repo (`ban/sdk`,
 *   `osm/sdk`, `tiger/sdk`, `bdc/sdk`, `filer/sdk`), and that is what these are: two http clients that
 *   fetch someone else's opinion about an address.
 */

// Re-exported so a caller branching on either client's failures needs exactly one import.
//
// Keep the convenience export here.
// `filer/sdk/sec-client.ts` and `bdc/sdk/client.ts` put their convenience exports on each client.
// Those packages each have one client, so their exports cannot collide.
// This package has two clients.
// `export *` from both modules would make their shared `ResourceError` name ambiguous.
// TypeScript would then omit `ResourceError` from this barrel.

export * from "#sdk/census/client"
export * from "#sdk/census/parser"
export * from "#sdk/census/types"
export * from "#sdk/google/client"
export * from "#sdk/map-link"
export * from "#sdk/google/parser"
export * from "#sdk/google/types"
