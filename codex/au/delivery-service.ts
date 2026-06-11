/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australia Post delivery-service designators (Postal Delivery Types) — the Commonwealth po_box
 *   vocabulary the US-only `us/po-box.ts` cannot see: `GPO Box 2890`, `Locked Bag 1797`,
 *   `Private Bag 7`, plus the rural/community legacy tail (`RMB 4600`, `RSD`, `CMB`).
 *
 *   Sourcing (accessed 2026-06-11; the underlying urban/rural addressing standard is AS/NZS 4819,
 *   which governs street addressing — the delivery-service designators below are Australia Post's
 *   own, from its addressing guidance):
 *
 *   - The complete Postal Delivery Type table comes verbatim from Australia Post's barcode
 *       addressing booklet ("Hints and tips to get a higher address match rate", SAP 8838883):
 *       CARE OF POST OFFICE→CARE PO, COMMUNITY MAIL AGENT→CMA, COMMUNITY MAIL BAG→CMB, GENERAL POST
 *       OFFICE BOX→GPO BOX, LOCKED MAIL BAG SERVICE→LOCKED BAG, MAIL SERVICE→MS, POST OFFICE
 *       BOX→PO BOX, POSTE RESTANTE→CARE PO, PRIVATE MAIL BAG SERVICE→PRIVATE BAG, ROADSIDE
 *       DELIVERY→RSD, ROADSIDE MAIL BAG→RMB, ROADSIDE MAIL BOX→RMB, ROADSIDE MAIL SERVICE→RMS,
 *       COMMUNITY POSTAL AGENT→CPA. The same booklet states: "With the exception of Care of Post
 *       Office, Community Mail Agent, Community Postal Agent, and Community Mail Bag, all Postal
 *       Delivery Types must have an associated number for a match to occur. e.g. PO Box 112", and
 *       "'PRIVATE BOX' is not a valid type" (so PRIVATE BOX is deliberately NOT in this table).
 *   - Which designators are CURRENT retail products (vs. AMAS-recognized legacy forms) comes from
 *       the live auspost.com.au pages: the addressing guidelines ("Line 2 should contain the street
 *       number and name, or PO Box or Locked Bag number"), the Correct Addressing brochure (SAP
 *       8833878, Nov 2022 — `GPO Box 123 / SYDNEY NSW 2000` example), the personal "PO Boxes and
 *       Private Bags" page (Private Bag: "If you live in a rural or remote area of Australia, you
 *       can manage your mail securely with a Private Bag"), and the business "PO Boxes and Locked
 *       Bags" page (GPO Box: "Lease a single GPO Box, or the same box number in each capital city
 *       with our Common Box service"; Common Box numbers run 9800–9999). PO Box, GPO Box, Locked
 *       Bag, and Private Bag appear on those current pages; the rural/community types (RSD, RMB,
 *       RMS, MS, CMB, CMA, CPA, Care PO) appear ONLY in the AMAS table and are flagged `legacy` —
 *       the parser must still recognize them on older addresses.
 *
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet (Postal Delivery Type table)}
 * @see {@link https://auspost.com.au/sending/guidelines/addressing-guidelines Australia Post addressing guidelines}
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/correct-addressing.pdf Australia Post Correct Addressing brochure (Nov 2022)}
 * @see {@link https://auspost.com.au/receiving/manage-your-mail/po-boxes-and-private-bags Australia Post — PO Boxes and Private Bags}
 * @see {@link https://auspost.com.au/business/business-admin/po-boxes-and-locked-bags Australia Post — business PO Boxes, GPO Boxes and Locked Bags}
 */

/** One Postal Delivery Type row from the Australia Post AMAS abbreviation table. */
export interface AuDeliveryServiceDesignator {
	/** The full Postal Delivery Type name, verbatim from the table (uppercase as published). */
	name: string
	/** The standard abbreviation — the surface form written on mail ("GPO BOX", "LOCKED BAG"). */
	abbreviation: string
	/**
	 * Whether the designator "must have an associated number for a match to occur" (AMAS rule;
	 * exceptions are Care of Post Office, Community Mail Agent, Community Postal Agent, and
	 * Community Mail Bag).
	 */
	requiresNumber: boolean
	/**
	 * True when the designator is recognized by the AMAS Postal Delivery Type table but absent from
	 * every current auspost.com.au addressing/product page (accessed 2026-06-11) — the rural and
	 * community forms superseded by rural street addressing under AS/NZS 4819. The parser must still
	 * RECOGNIZE these on old addresses; synthesis should weight them low.
	 */
	legacy: boolean
}

/**
 * The verbatim Postal Delivery Type table (see the module header for the per-row provenance).
 * Multiple names can share an abbreviation (ROADSIDE MAIL BAG and ROADSIDE MAIL BOX are both RMB;
 * POSTE RESTANTE is addressed as CARE PO).
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

/** A canonical Australia Post Postal Delivery Type abbreviation. */
export type AuDeliveryServiceAbbreviation = (typeof AU_DELIVERY_SERVICE_DESIGNATORS)[number]["abbreviation"]

/**
 * Per-designator surface patterns (designator phrase only, no anchor, no id). Ordered longest /
 * most-specific first so the matcher prefers "GPO Box" over "PO Box" and "RMS" over "MS". Each
 * pattern tolerates the punctuation AMAS tells mailers to strip ("the full stops and commas in
 * R.M.B and P.O.") — recognition must accept what deliverable mail actually carries.
 *
 * MS is special-cased in {@link matchAuDeliveryService}: its identifier must start with a digit so
 * the bare two-letter designator cannot swallow an honorific ("Ms Smith").
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

// One anchored regex per designator: phrase + (required|optional) identifier. The id shape matches
// the US slice ([\dA-Za-z][\dA-Za-z-]*); MS additionally requires a digit-leading id (see above).
const MATCHERS: ReadonlyArray<{ abbreviation: AuDeliveryServiceAbbreviation; re: RegExp }> = DESIGNATOR_PATTERNS.map(
	([abbreviation, src]) => {
		const { requiresNumber } = DESIGNATOR_INFO.get(abbreviation)!
		const id = abbreviation === "MS" ? String.raw`(\d[\dA-Za-z-]*)` : String.raw`([\dA-Za-z][\dA-Za-z-]*)`
		const tail = requiresNumber ? String.raw`\s*#?\s*${id}` : String.raw`(?:\s*#?\s*${id})?`
		return { abbreviation, re: new RegExp(String.raw`^\s*(${src})${tail}\s*$`, "i") }
	}
)

/** Result of an AU delivery-service parse. */
export interface AuDeliveryServiceMatch {
	/** The designator phrase as it appeared ("G.P.O. Box", "Locked Bag"). */
	matched: string
	/** The canonical Postal Delivery Type abbreviation ("GPO BOX", "LOCKED BAG"). */
	designator: AuDeliveryServiceAbbreviation
	/** The delivery-service number when present ("9999", "4600"). */
	id?: string
	/** True when the designator is an AMAS-only legacy form (see the table). */
	legacy: boolean
}

/**
 * If `input` is a standalone Australia Post delivery-service phrase ("GPO Box 2890",
 * "Locked Bag 1797", "RMB 4600", bare "CMB"), return the canonical designator, the id, and the
 * legacy flag. Null otherwise — including for "Private Box", which Australia Post explicitly calls
 * out as not a valid type.
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

/** Type-predicate: does the input look like a standalone AU delivery-service address line? */
export function isAuDeliveryService(input: unknown): boolean {
	return matchAuDeliveryService(input) !== null
}

/**
 * Normalize a recognized delivery-service phrase to the canonical AMAS form
 * (`"g.p.o. box 123"` → `"GPO BOX 123"`). Returns the input unchanged if it isn't one.
 */
export function normalizeAuDeliveryService(input: string): string {
	const m = matchAuDeliveryService(input)
	if (!m) return input
	return m.id ? `${m.designator} ${m.id.toUpperCase()}` : m.designator
}
