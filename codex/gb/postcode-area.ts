/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode AREA → constituent country, the Royal Mail mapping — and the concrete proof of the
 *   lesson in `postcode.ts` that UK postcodes do NOT track administrative geography.
 *
 *   A postcode area is the leading one or two letters of a postcode (`SW`, `M`, `EH`, `BT`), named
 *   after the sorting town Royal Mail routes it through, NOT after a county or a constituent
 *   country. There is no clean postcode→admin hierarchy to inherit the way France gives you a
 *   département from the first two digits. The only honest thing we _can_ derive is which of the
 *   four UK countries an area predominantly falls in — and even that has border exceptions:
 *
 *   - **TD** (Galashiels) and **SY** (Shrewsbury) straddle the Scotland/England and Wales/England
 *       borders respectively; each is assigned to its MAJORITY country here (TD → Scotland, SY →
 *       Wales). A handful of individual postcodes on the wrong side of the line are a gazetteer
 *       concern, not a thing this coarse table tries to model.
 *
 *   So this is the ROYAL MAIL area→country mapping, and the fact that it needs a hand-built
 *   non-England set with documented border fudges — rather than a tidy prefix rule — is exactly why
 *   a UK postcode is not a county.
 */

import type { UkCountryCode } from "./country.js"

/** Northern Ireland is a single postcode area: BT (Belfast). */
const NORTHERN_IRELAND_AREAS = ["BT"] as const

/**
 * Scotland's postcode areas. TD (Galashiels) straddles the border with England and is assigned to Scotland as its
 * majority country.
 */
const SCOTLAND_AREAS = [
	"AB", // Aberdeen
	"DD", // Dundee
	"DG", // Dumfries
	"EH", // Edinburgh
	"FK", // Falkirk
	"G", //  Glasgow
	"HS", // Outer Hebrides (Na h-Eileanan Siar)
	"IV", // Inverness
	"KA", // Kilmarnock
	"KW", // Kirkwall (Orkney + Caithness)
	"KY", // Kirkcaldy (Fife)
	"ML", // Motherwell
	"PA", // Paisley
	"PH", // Perth
	"TD", // Galashiels (Scottish Borders) — straddles the England border, majority Scotland
	"ZE", // Lerwick (Shetland)
] as const

/**
 * Wales's postcode areas. SY (Shrewsbury) straddles the border with England and is assigned to Wales as its majority
 * country.
 */
const WALES_AREAS = [
	"CF", // Cardiff
	"LD", // Llandrindod Wells
	"LL", // Llandudno
	"NP", // Newport
	"SA", // Swansea
	"SY", // Shrewsbury — straddles the Wales/England border, majority Wales
] as const

/**
 * The explicit non-England postcode areas, area → constituent country. England is intentionally absent: it is the
 * DEFAULT (the great majority of UK areas are English), so listing it would be both enormous and a maintenance trap.
 * Keeping only the non-England set makes the default transparent — anything not named here is England.
 */
export const GB_POSTCODE_AREA_COUNTRY: Record<string, UkCountryCode> = {
	...Object.fromEntries(NORTHERN_IRELAND_AREAS.map((a) => [a, "NIR" as const])),
	...Object.fromEntries(SCOTLAND_AREAS.map((a) => [a, "SCT" as const])),
	...Object.fromEntries(WALES_AREAS.map((a) => [a, "WLS" as const])),
}

/** True when `area` looks like a valid postcode-area string: one or two ASCII letters. */
function isAreaShape(area: unknown): area is string {
	return typeof area === "string" && /^[A-Z]{1,2}$/i.test(area)
}

/**
 * The constituent country a postcode AREA belongs to. Returns the explicit country for a known non-England area (e.g.
 * `BT` → `NIR`, `G` → `SCT`, `CF` → `WLS`), and `ENG` as the default for any other validly-shaped area — England is by
 * far the largest, so the default is transparent and the non-England exceptions live in
 * {@link GB_POSTCODE_AREA_COUNTRY}. Returns null for clearly-invalid input (not one-or-two letters), so a malformed
 * token is not silently called England.
 */
export function countryOfPostcodeArea(area: unknown): UkCountryCode | null {
	if (!isAreaShape(area)) return null

	return GB_POSTCODE_AREA_COUNTRY[area.toUpperCase()] ?? "ENG"
}

/**
 * The constituent country a whole postcode resolves to, by extracting its area. `BT1 1AA` → `NIR`, `EH1 1BB` → `SCT`,
 * `CF10 1AA` → `WLS`, `SW1A 1AA` → `ENG`. Null if the input has no extractable postcode area.
 */
export function countryOfPostcode(postcode: unknown): UkCountryCode | null {
	if (typeof postcode !== "string") return null
	// Extract the leading 1-2 letters directly, tolerating the inward code / spacing.
	const match = /^\s*([A-Z]{1,2})/i.exec(postcode)

	if (!match) return null

	return countryOfPostcodeArea(match[1])
}
