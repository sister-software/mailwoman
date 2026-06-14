/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/record` — the canonicalize layer for the geocode-first matcher.
 *
 *   Address-first: {@linkcode PostalAddress} is the spine. The per-field normalizers
 *   ({@linkcode parsePersonName}, {@linkcode canonicalizeOrganizationName}) build on the same
 *   plain-data pattern. Contact records and the comparator/Fellegi-Sunter layer land in the
 *   matcher.
 */

export * from "./address.js"
export * from "./name.js"
export * from "./organization.js"
