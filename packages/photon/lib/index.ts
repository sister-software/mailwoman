/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/photon` is a Photon-compatible autocomplete / type-ahead geocoding API over the
 *   Mailwoman engine. Where `@mailwoman/nominatim` is structured lookup, Photon is
 *   search-as-you-type: a GeoJSON `FeatureCollection` per query, biased by location, ranked for
 *   prefixes. It maps onto Mailwoman's shipped FST autocomplete tier and the parse then resolve
 *   path.
 *
 *   Like its siblings, the package is engine-agnostic. {@link createPhotonApp} takes a
 *   {@link PhotonEngine}, and the CLI wires the real engine. Routes whose engine method is absent
 *   answer `501`.
 */

export * from "#app"
export * from "#engine"
export * from "#projection"
export * from "#schema"
