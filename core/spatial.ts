/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Small, dependency-free spatial helpers. Pure math only — safe to import from browser-bound code
 *   (the demo's resolver cascade pulls {@link haversineKm} transitively through `span-rescore.ts`).
 */

/**
 * Great-circle distance between two WGS-84 points, in kilometres (mean Earth radius 6371 km). The
 * one true copy — resolver levers and eval harnesses import this rather than re-deriving the six
 * lines (a 2026-06-23 review found it copied five ways across the branch; a precision tweak in one
 * copy and not the others is the hazard this closes).
 */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const R = 6371
	const dLat = ((bLat - aLat) * Math.PI) / 180
	const dLon = ((bLon - aLon) * Math.PI) / 180
	const la1 = (aLat * Math.PI) / 180
	const la2 = (bLat * Math.PI) / 180
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(h))
}
