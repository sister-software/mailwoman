/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NZ Post delivery-service types and identifier rules from ADV358. The parser also recognizes the unofficial
 *   alias "Private Box" for a PO Box.
 *
 * @see {@link https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf NZ Post Address Standards (ADV358, Oct 2021)}
 * @see {@link https://www.nzpost.co.nz/business/shipping-in-nz/addressing-standards NZ Post addressing standards}
 * @see {@link https://www.nzpost.co.nz/personal/sending-in-nz/how-to-address-mail NZ Post — how to address mail}
 */

/**
 * An ADV358 identifier rule.
 */
export type NZIdentifierRule = "required-if-allocated" | "optional" | "not-used"

/**
 * One ADV358 delivery-service type.
 */
export interface NZDeliveryServiceType {
	/**
	 * The type name as published in ADV358.
	 */
	type: string
	/**
	 * The ADV358 description.
	 */
	description: string
	/**
	 * Whether the type takes an identifier.
	 *
	 * PO Box, Response Bag and CMB require one.
	 * Private Bag may omit it.
	 * Counter Delivery and Poste Restante never use one.
	 */
	identifier: NZIdentifierRule
}

/**
 * The six valid delivery-service types listed in ADV358.
 */
export const NZ_DELIVERY_SERVICE_TYPES = [
	{ type: "PO Box", description: "Post Box, PO Box", identifier: "required-if-allocated" },
	{ type: "Private Bag", description: "Private Bag", identifier: "optional" },
	{ type: "Response Bag", description: "Response Bag (used for competitions)", identifier: "required-if-allocated" },
	{
		type: "CMB",
		description: "Community Mail Box in postal outlet or on a thoroughfare",
		identifier: "required-if-allocated",
	},
	{
		type: "Counter Delivery",
		description: "Hold for Counter Delivery collection - domestic mail",
		identifier: "not-used",
	},
	{
		type: "Poste Restante",
		description: "Hold for Poste Restante collection - international mail",
		identifier: "not-used",
	},
] as const satisfies readonly NZDeliveryServiceType[]

/**
 * A valid ADV358 delivery-service type.
 */
export type NZDeliveryServiceTypeName = (typeof NZ_DELIVERY_SERVICE_TYPES)[number]["type"]

/**
 * Metadata for "Private Box", a colloquial alias for a PO Box that ADV358 does not list.
 *
 * The parser recognizes it, and synthesis should avoid it.
 */
export const NZ_PRIVATE_BOX_ALIAS = {
	/**
	 * The alias as written on mail.
	 */
	type: "Private Box",
	/**
	 * The alias's meaning and status.
	 */
	description: "Colloquial NZ synonym for a numbered PO Box — NOT a valid ADV358 Delivery Service Type",
	/**
	 * The identifier rule, copied from PO Box.
	 */
	identifier: "required-if-allocated" satisfies NZIdentifierRule,
	/**
	 * Marks the alias as absent from ADV358.
	 */
	officiallyInvalid: true,
} as const

/**
 * Patterns for each type and the "Private Box" alias, including punctuation variants.
 */
const TYPE_PATTERNS: ReadonlyArray<readonly [NZDeliveryServiceTypeName | "Private Box", string]> = [
	["PO Box", String.raw`p\.?\s*o\.?\s*box|post\s+box`],
	["Private Bag", String.raw`private\s+bag`],
	["Private Box", String.raw`private\s+box`],
	["Response Bag", String.raw`response\s+bag`],
	["CMB", String.raw`community\s+mail\s+box|cmb`],
	["Counter Delivery", String.raw`counter\s+delivery`],
	["Poste Restante", String.raw`poste\s+restante`],
]

/**
 * A type name the parser can return, including the "Private Box" alias.
 */
export type NZDeliveryServiceMatchTypeName = NZDeliveryServiceTypeName | "Private Box"

const IDENTIFIER_RULES = new Map<NZDeliveryServiceMatchTypeName, NZIdentifierRule>([
	...NZ_DELIVERY_SERVICE_TYPES.map((t) => [t.type, t.identifier] as const),
	["Private Box", NZ_PRIVATE_BOX_ALIAS.identifier],
])

/**
 * An anchored regular expression for each type and its identifier rule.
 */
const MATCHERS: ReadonlyArray<{ type: NZDeliveryServiceMatchTypeName; re: RegExp }> = TYPE_PATTERNS.map(
	([type, src]) => {
		const rule = IDENTIFIER_RULES.get(type)!
		const tail = rule === "not-used" ? "" : String.raw`(?:\s+([\dA-Za-z]+))${rule === "optional" ? "?" : ""}`

		return { type, re: new RegExp(String.raw`^\s*(${src})${tail}\s*$`, "i") }
	}
)

/**
 * A parsed New Zealand delivery-service line.
 */
export interface NZDeliveryServiceMatch {
	/**
	 * The designator as written.
	 */
	matched: string
	/**
	 * The canonical type or the "Private Box" alias.
	 */
	type: NZDeliveryServiceMatchTypeName
	/**
	 * The identifier, when present, such as "24999" or "B99".
	 */
	id?: string
	/**
	 * Set when the input uses the "Private Box" alias.
	 */
	colloquial?: true
}

/**
 * Parses a standalone delivery-service line.
 *
 * Returns `null` for other input.
 * A "Private Box" match sets `colloquial` so callers can exclude it.
 */
export function matchNZDeliveryService(input: unknown): NZDeliveryServiceMatch | null {
	if (typeof input !== "string") return null

	for (const { type, re } of MATCHERS) {
		const m = re.exec(input)

		if (!m) continue
		const colloquial = type === "Private Box" ? ({ colloquial: true } as const) : {}

		return { matched: m[1]!.trim(), type, ...(m[2] ? { id: m[2] } : {}), ...colloquial }
	}

	return null
}

/**
 * Returns whether the input is a delivery-service line.
 */
export function isNZDeliveryService(input: unknown): boolean {
	return matchNZDeliveryService(input) !== null
}

/**
 * Normalizes a delivery-service line to its canonical type and uppercased identifier.
 *
 * @returns The input unchanged when it is not a delivery-service line.
 */
export function normalizeNZDeliveryService(input: string): string {
	const m = matchNZDeliveryService(input)

	if (!m) return input

	return m.id ? `${m.type} ${m.id.toUpperCase()}` : m.type
}
