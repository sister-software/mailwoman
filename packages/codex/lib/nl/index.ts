/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dutch postal reference. The PC6 postcode key is the whole of it: NL has no entry in
 *   `candidateSystemsForPostcode`'s table, which asks which address system's own shape a postcode
 *   fits, and registering one there would change which systems that function reports.
 */

export * from "#nl/postcode"
