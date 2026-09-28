/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `zoning_area.rings` — the blob layout and point test re-exported from `@mailwoman/spatial`;
 *   `resolveRingRoles` stays local because the clockwise-exterior role encoding belongs to this publisher rather than to geometry.
 */

export { resolveRingRoles, type ResolvedRingRoles } from "#ring-roles"
