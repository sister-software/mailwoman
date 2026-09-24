/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NZ Post delivery-service types from ADV358, including the identifier rules for numbered and
 *   counter services. "Private Box" is also recognized as an unofficial alias for numbered PO Boxes;
 *   it remains separate from the six valid types. Sources were checked on 2026-06-11.
 * @see {@link https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf NZ Post Address Standards (ADV358, Oct 2021)}
 * @see {@link https://www.nzpost.co.nz/business/shipping-in-nz/addressing-standards NZ Post addressing standards}
 * @see {@link https://www.nzpost.co.nz/personal/sending-in-nz/how-to-address-mail NZ Post — how to address mail}
 */

/**
 * Identifier rule from ADV358.
 */
export type NZIdentifierRule = "required-if-allocated" | "optional" | "not-used"

/**
 * One ADV358 delivery-service type.
 */
export interface NZDeliveryServiceType {
	/**
	 * Delivery Service Type as published in ADV358.
	 */
	type: string
	/**
	 * Description from ADV358.
	 */
	description: string
	/**
	 * PO Box, Response Bag, and CMB require an allocated identifier.
	 *
	 * Private Bag may omit it; Counter Delivery and Poste Restante never use one.
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
 * Metadata for "Private Box", a colloquial alias absent from ADV358 and current NZ Post standards.
 *
 * It is recognized for parsing only and should not be treated as a prescribed form.
 */
export const NZ_PRIVATE_BOX_ALIAS = {
	/**
	 * Colloquial surface used on real mail.
	 */
	type: "Private Box",
	/**
	 * Status and meaning of the alias.
	 */
	description: "Colloquial NZ synonym for a numbered PO Box — NOT a valid ADV358 Delivery Service Type",
	/**
	 * Identifier rule inherited from PO Box.
	 */
	identifier: "required-if-allocated" satisfies NZIdentifierRule,
	/**
	 * True because this alias is not an ADV358 type.
	 */
	officiallyInvalid: true,
} as const

/**
 * Accepted surface patterns, including punctuation variants and the separate "Private Box" alias.
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
 * Extended type name union including the colloquial alias recognized for parsing.
 */
export type NZDeliveryServiceMatchTypeName = NZDeliveryServiceTypeName | "Private Box"

const IDENTIFIER_RULES = new Map<NZDeliveryServiceMatchTypeName, NZIdentifierRule>([
	...NZ_DELIVERY_SERVICE_TYPES.map((t) => [t.type, t.identifier] as const),
	// Apply the PO Box identifier rule to the colloquial alias.
	["Private Box", NZ_PRIVATE_BOX_ALIAS.identifier],
])

/**
 * Anchored matcher for each type, using ADV358's identifier format.
 */
const MATCHERS: ReadonlyArray<{ type: NZDeliveryServiceMatchTypeName; re: RegExp }> = TYPE_PATTERNS.map(
	([type, src]) => {
		const rule = IDENTIFIER_RULES.get(type)!
		const tail = rule === "not-used" ? "" : String.raw`(?:\s+([\dA-Za-z]+))${rule === "optional" ? "?" : ""}`

		return { type, re: new RegExp(String.raw`^\s*(${src})${tail}\s*$`, "i") }
	}
)

/**
 * Parsed New Zealand delivery-service line.
 */
export interface NZDeliveryServiceMatch {
	/**
	 * Designator as written in the input.
	 */
	matched: string
	/**
	 * Canonical type or recognized alias.
	 * "Private Box" is colloquial, not an ADV358 type.
	 */
	type: NZDeliveryServiceMatchTypeName
	/**
	 * The Delivery Service Identifier when present ("24999", "B99").
	 */
	id?: string
	/**
	 * Present only when the input uses the colloquial alias.
	 */
	colloquial?: true
}

/**
 * Parse a standalone delivery-service phrase.
 *
 * Return `null` for unrecognized forms; results for "Private Box" include `colloquial: true`
 * so callers can exclude the unofficial alias.
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
 * Return whether the input is a recognized delivery-service line.
 */
export function isNZDeliveryService(input: unknown): boolean {
	return matchNZDeliveryService(input) !== null
}

/**
 * Normalize a recognized phrase to its canonical type and identifier.
 *
 * @returns The input unchanged if it isn't a delivery-service phrase.
 */
export function normalizeNZDeliveryService(input: string): string {
	const m = matchNZDeliveryService(input)

	if (!m) return input

	return m.id ? `${m.type} ${m.id.toUpperCase()}` : m.type
}
