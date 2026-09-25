/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australia Post delivery-service designators, from the Postal Delivery Type table in the barcode addressing
 *   booklet.
 *
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet (Postal Delivery Type table)}
 * @see {@link https://auspost.com.au/sending/guidelines/addressing-guidelines Australia Post addressing guidelines}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf Australia Post Correct Addressing brochure (Nov 2022)}
 * @see {@link https://auspost.com.au/receiving/manage-your-mail/po-boxes-and-private-bags Australia Post — PO Boxes and Private Bags}
 * @see {@link https://auspost.com.au/business/business-admin/po-boxes-and-locked-bags Australia Post — business PO Boxes, GPO Boxes and Locked Bags}
 */

/**
 * One entry from Australia Post's Postal Delivery Type table.
 */
export interface AuDeliveryServiceDesignator {
	/**
	 * The published type name.
	 */
	name: string
	/**
	 * The abbreviation used on mail.
	 */
	abbreviation: string
	/**
	 * Whether the designator must be followed by a number.
	 */
	requiresNumber: boolean
	/**
	 * Whether the type is missing from current Australia Post product pages.
	 *
	 * Parsers still recognize legacy types.
	 * Synthesis should use them rarely.
	 */
	legacy: boolean
}

/**
 * Postal Delivery Types and their published abbreviations.
 * Some names share an abbreviation.
 */
export const AU_DELIVERY_SERVICE_DESIGNATORS = [
	{ name: "GENERAL POST OFFICE BOX", abbreviation: "GPO BOX", requiresNumber: true, legacy: false },
	{ name: "POST OFFICE BOX", abbreviation: "PO BOX", requiresNumber: true, legacy: false },
	{ name: "LOCKED MAIL BAG SERVICE", abbreviation: "LOCKED BAG", requiresNumber: true, legacy: false },
	{ name: "PRIVATE MAIL BAG SERVICE", abbreviation: "PRIVATE BAG", requiresNumber: true, legacy: false },
	{ name: "COMMUNITY MAIL BAG", abbreviation: "CMB", requiresNumber: false, legacy: true },
	{ name: "COMMUNITY MAIL AGENT", abbreviation: "CMA", requiresNumber: false, legacy: true },
	{ name: "COMMUNITY POSTAL AGENT", abbreviation: "CPA", requiresNumber: false, legacy: true },
	{ name: "CARE OF POST OFFICE", abbreviation: "CARE PO", requiresNumber: false, legacy: true },
	{ name: "POSTE RESTANTE", abbreviation: "CARE PO", requiresNumber: false, legacy: true },
	{ name: "MAIL SERVICE", abbreviation: "MS", requiresNumber: true, legacy: true },
	{ name: "ROADSIDE DELIVERY", abbreviation: "RSD", requiresNumber: true, legacy: true },
	{ name: "ROADSIDE MAIL BAG", abbreviation: "RMB", requiresNumber: true, legacy: true },
	{ name: "ROADSIDE MAIL BOX", abbreviation: "RMB", requiresNumber: true, legacy: true },
	{ name: "ROADSIDE MAIL SERVICE", abbreviation: "RMS", requiresNumber: true, legacy: true },
] as const satisfies readonly AuDeliveryServiceDesignator[]

/**
 * A canonical Australia Post Postal Delivery Type abbreviation.
 */
export type AuDeliveryServiceAbbreviation = (typeof AU_DELIVERY_SERVICE_DESIGNATORS)[number]["abbreviation"]

/**
 * Designator patterns in match order.
 *
 * `MS` requires an identifier that starts with a digit, so "Ms Smith" does not match.
 */
const DESIGNATOR_PATTERNS: ReadonlyArray<readonly [AuDeliveryServiceAbbreviation, string]> = [
	["GPO BOX", String.raw`general\s+post\s+office\s+box|g\.?\s*p\.?\s*o\.?\s*box`],
	["PO BOX", String.raw`post\s+office\s+box|p\.?\s*o\.?\s*box`],
	["LOCKED BAG", String.raw`locked\s+(?:mail\s+)?bag(?:\s+service)?`],
	["PRIVATE BAG", String.raw`private\s+(?:mail\s+)?bag(?:\s+service)?`],
	["CARE PO", String.raw`care\s+of\s+post\s+office|poste\s+restante|care\s+po`],
	["CMB", String.raw`community\s+mail\s+bag|cmb`],
	["CMA", String.raw`community\s+mail\s+agent|cma`],
	["CPA", String.raw`community\s+postal\s+agent|cpa`],
	["RSD", String.raw`roadside\s+delivery|r\.?\s*s\.?\s*d\.?`],
	["RMB", String.raw`roadside\s+mail\s+(?:bag|box)|r\.?\s*m\.?\s*b\.?`],
	["RMS", String.raw`roadside\s+mail\s+service|rms`],
	["MS", String.raw`mail\s+service|ms`],
]

const DESIGNATOR_INFO = new Map<AuDeliveryServiceAbbreviation, { requiresNumber: boolean; legacy: boolean }>(
	AU_DELIVERY_SERVICE_DESIGNATORS.map((d) => [d.abbreviation, { requiresNumber: d.requiresNumber, legacy: d.legacy }])
)

/**
 * An anchored regular expression for each designator and its identifier.
 */
const MATCHERS: ReadonlyArray<{ abbreviation: AuDeliveryServiceAbbreviation; re: RegExp }> = DESIGNATOR_PATTERNS.map(
	([abbreviation, src]) => {
		const { requiresNumber } = DESIGNATOR_INFO.get(abbreviation)!
		const id = abbreviation === "MS" ? String.raw`(\d[\dA-Za-z-]*)` : String.raw`([\dA-Za-z][\dA-Za-z-]*)`
		const tail = requiresNumber ? String.raw`\s*#?\s*${id}` : String.raw`(?:\s*#?\s*${id})?`

		return { abbreviation, re: new RegExp(String.raw`^\s*(${src})${tail}\s*$`, "i") }
	}
)

/**
 * A parsed Australian delivery-service line.
 */
export interface AuDeliveryServiceMatch {
	/**
	 * The designator phrase as written, such as "G.P.O.
	 * Box".
	 */
	matched: string
	/**
	 * The canonical abbreviation, such as "GPO BOX" or "LOCKED BAG".
	 */
	designator: AuDeliveryServiceAbbreviation
	/**
	 * The delivery-service number, when present.
	 */
	id?: string
	/**
	 * Whether the designator is a legacy type.
	 */
	legacy: boolean
}

/**
 * Parses a standalone Australia Post delivery-service line, such as "GPO Box 2890" or a bare "CMB".
 *
 * Returns null for any other input.
 * Australia Post lists "Private Box" as invalid, and it returns null.
 */
export function matchAuDeliveryService(input: unknown): AuDeliveryServiceMatch | null {
	if (typeof input !== "string") return null

	for (const { abbreviation, re } of MATCHERS) {
		const m = re.exec(input)

		if (!m) continue
		const info = DESIGNATOR_INFO.get(abbreviation)!

		return {
			matched: m[1]!.trim(),
			designator: abbreviation,
			...(m[2] ? { id: m[2] } : {}),
			legacy: info.legacy,
		}
	}

	return null
}

/**
 * Returns whether the input is a standalone Australian delivery-service line.
 */
export function isAuDeliveryService(input: unknown): boolean {
	return matchAuDeliveryService(input) !== null
}

/**
 * Normalizes a delivery-service line to its canonical form, so `"g.p.o. Box 123"` becomes `"GPO BOX 123"`.
 *
 * @returns The input unchanged when it is not a delivery-service line.
 */
export function normalizeAuDeliveryService(input: string): string {
	const m = matchAuDeliveryService(input)

	if (!m) return input

	return m.id ? `${m.designator} ${m.id.toUpperCase()}` : m.designator
}
