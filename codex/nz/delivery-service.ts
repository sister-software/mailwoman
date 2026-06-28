/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NZ Post delivery-service types — the second half of the Commonwealth po_box vocabulary: `PO Box
 *   24999`, `Private Bag 106999`, `CMB B99`, plus the identifier-less counter services, plus the
 *   colloquial "Private Box" alias documented here for recognition with its 'invalid' citation.
 *
 *   Sourcing (accessed 2026-06-11):
 *
 *   - NZ Post Address Standards (ADV358, October 2021 edition hosted on nzpost.co.nz) is the
 *       authoritative document. Verbatim: "The Delivery Service Type is mandatory. It may be PO
 *       Box, Private Bag, CMB, Response Bag, Counter Delivery or Poste Restante." Its Delivery
 *       Service Elements table gives the descriptions reproduced in
 *       {@link NZ_DELIVERY_SERVICE_TYPES}, and the identifier rules: "The Delivery Service
 *       Identifier must have no leading zeros and no spaces, separators or other punctuation"; "The
 *       Delivery Service Identifier is not used for Counter Delivery or Poste Restante. It is also
 *       not used for Private Bags that do not have an identifier allocated by New Zealand Post".
 *       Examples: `PO Box 24999`, `Private Bag 106999`, `Response Bag 500999`, `CMB B99`, `Counter
 *       Delivery`, `Poste Restante`. The standard's incorrect-form examples show `P O Box 4 099`
 *       and `PB 39990` as wrong — `PB` is a common error, not a designator, so it is NOT in this
 *       table.
 *   - The live addressing-standards page repeats the format rules: "PO Box and Private Bag numbers are
 *       space-free (eg. 'PO Box 23226', not 'PO Box 23 226')", "'PO' is space-free … and
 *       punctuation-free".
 *
 *   All six types are CURRENT in the October 2021 ADV358 (including CMB — no legacy flag is needed
 *   for the NZ slice).
 *
 *   **"Private Box" — colloquial alias, officially invalid:** ADV358 does not list "Private Box" as a
 *   Delivery Service Type and NZ Post's live standards pages (addressing-standards, how-to-address-
 *   mail, accessed 2026-06-11) name only the six types above. However, real NZ mail and the postal
 *   arena's gold rows carry "Private Box" as a colloquial synonym for a numbered PO Box (same
 *   numbered format, different label). Operator ruling 2026-06-11: "Private Box = recognize-as-used
 *   — codex documents it unofficial/colloquial WITH the 'officially invalid' citation; the shard
 *   teaches recognition (validity and recognition are separate disciplines, same as the AU legacy
 *   flags)." This is encoded in {@link NZ_PRIVATE_BOX_ALIAS} — a distinct export from
 *   {@link NZ_DELIVERY_SERVICE_TYPES} so callers can choose whether to include the unofficial form.
 * @see {@link https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf NZ Post Address Standards (ADV358, Oct 2021)}
 * @see {@link https://www.nzpost.co.nz/business/shipping-in-nz/addressing-standards NZ Post addressing standards}
 * @see {@link https://www.nzpost.co.nz/personal/sending-in-nz/how-to-address-mail NZ Post — how to address mail}
 */

/** Identifier requirement per ADV358's Delivery Service Elements rules. */
export type NzIdentifierRule = "required-if-allocated" | "optional" | "not-used"

/** One Delivery Service Type row from ADV358. */
export interface NzDeliveryServiceType {
	/** The Delivery Service Type, verbatim casing per ADV358 ("PO Box", "Private Bag", "CMB"). */
	type: string
	/** The ADV358 description, verbatim. */
	description: string
	/**
	 * Identifier rule: PO Box/Response Bag/CMB identifiers are mandatory if allocated; Private Bag may legitimately have
	 * none ("not used … for Private Bags that do not have an identifier allocated by New Zealand Post"); Counter Delivery
	 * and Poste Restante never carry one.
	 */
	identifier: NzIdentifierRule
}

/** The six Delivery Service Types, verbatim from ADV358 (see the module header). */
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
] as const satisfies readonly NzDeliveryServiceType[]

/** A canonical NZ Delivery Service Type. */
export type NzDeliveryServiceTypeName = (typeof NZ_DELIVERY_SERVICE_TYPES)[number]["type"]

/**
 * Metadata for the colloquial "Private Box" alias (see the module header and operator ruling 2026-06-11). Kept separate
 * from {@link NZ_DELIVERY_SERVICE_TYPES} because it is NOT a valid ADV358 Delivery Service Type — recognition and
 * validity are separate concerns.
 *
 * Sourcing: ADV358 (Oct 2021) omits "Private Box" from its Delivery Service Type list entirely. NZ Post's live
 * standards pages (nzpost.co.nz/business/shipping-in-nz/addressing-standards and
 * nzpost.co.nz/personal/sending-in-nz/how-to-address-mail, accessed 2026-06-11) do not list it as a valid type. Real NZ
 * mail and the postal arena's gold rows nonetheless carry it as a colloquial synonym for a numbered PO Box. Operator
 * ruling 2026-06-11 authorizes its inclusion here for recognition only, with this citation; corpus synthesis should
 * treat it as a non-prescriptive form.
 */
export const NZ_PRIVATE_BOX_ALIAS = {
	/** The surface form as it appears on real mail and in postal-arena gold rows. */
	type: "Private Box",
	/**
	 * The description of validity status — NOT a valid ADV358 Delivery Service Type; a colloquial NZ synonym for a
	 * numbered PO Box (same format as "PO Box <number>").
	 */
	description: "Colloquial NZ synonym for a numbered PO Box — NOT a valid ADV358 Delivery Service Type",
	/** Identifier rule mirrors PO Box: a number is expected when the alias is used with one. */
	identifier: "required-if-allocated" satisfies NzIdentifierRule,
	/**
	 * True — this form is NOT valid per ADV358 or NZ Post's live standards pages (accessed 2026-06-11).
	 */
	officiallyInvalid: true,
} as const

/**
 * Per-type surface patterns (designator phrase only). Recognition is deliberately wider than the prescriptive standard
 * — mail in the wild writes "P.O. Box" even though ADV358 says `PO` is punctuation-free — but it does NOT admit forms
 * the standard names as errors of TYPE (`PB`).
 *
 * The colloquial "Private Box" alias is included for recognition (see {@link NZ_PRIVATE_BOX_ALIAS} and operator ruling
 * 2026-06-11); it maps to a distinct synthetic type string so callers can distinguish it from the ADV358 types.
 */
const TYPE_PATTERNS: ReadonlyArray<readonly [NzDeliveryServiceTypeName | "Private Box", string]> = [
	["PO Box", String.raw`p\.?\s*o\.?\s*box|post\s+box`],
	["Private Bag", String.raw`private\s+bag`],
	["Private Box", String.raw`private\s+box`],
	["Response Bag", String.raw`response\s+bag`],
	["CMB", String.raw`community\s+mail\s+box|cmb`],
	["Counter Delivery", String.raw`counter\s+delivery`],
	["Poste Restante", String.raw`poste\s+restante`],
]

/** Extended type name union including the colloquial alias recognized for parsing. */
export type NzDeliveryServiceMatchTypeName = NzDeliveryServiceTypeName | "Private Box"

const IDENTIFIER_RULES = new Map<NzDeliveryServiceMatchTypeName, NzIdentifierRule>([
	...NZ_DELIVERY_SERVICE_TYPES.map((t) => [t.type, t.identifier] as const),
	// "Private Box" mirrors PO Box identifier rules (required-if-allocated) per the alias metadata.
	["Private Box", NZ_PRIVATE_BOX_ALIAS.identifier],
])

// One anchored regex per type. The identifier shape follows ADV358 (alphanumeric, no spaces or
// separators — `24999`, `B99`); the identifier-less counter services take no tail at all.
const MATCHERS: ReadonlyArray<{ type: NzDeliveryServiceMatchTypeName; re: RegExp }> = TYPE_PATTERNS.map(
	([type, src]) => {
		const rule = IDENTIFIER_RULES.get(type)!
		const tail = rule === "not-used" ? "" : String.raw`(?:\s+([\dA-Za-z]+))${rule === "optional" ? "?" : ""}`

		return { type, re: new RegExp(String.raw`^\s*(${src})${tail}\s*$`, "i") }
	}
)

/** Result of an NZ delivery-service parse. */
export interface NzDeliveryServiceMatch {
	/** The designator phrase as it appeared ("PO Box", "private bag", "Private Box"). */
	matched: string
	/**
	 * The canonical Delivery Service Type or recognized alias ("PO Box", "Private Bag", "CMB", …, "Private Box"). When
	 * `type` is "Private Box", `colloquial` is true and `officiallyInvalid` is true — the form is not a valid ADV358
	 * type.
	 */
	type: NzDeliveryServiceMatchTypeName
	/** The Delivery Service Identifier when present ("24999", "B99"). */
	id?: string
	/**
	 * True when the matched form is the colloquial "Private Box" alias — not a valid ADV358 Delivery Service Type. Absent
	 * (undefined) for all standard ADV358 types.
	 */
	colloquial?: true
}

/**
 * If `input` is a standalone NZ delivery-service phrase ("PO Box 24999", "Private Bag 106999", "CMB B99", bare "Private
 * Bag", "Counter Delivery", "Private Box 102"), return the canonical type and identifier. Null otherwise — including
 * for "PB 39990" (an error of form per ADV358).
 *
 * When `type` is "Private Box", the result carries `colloquial: true` — indicating the colloquial alias (not an ADV358
 * Delivery Service Type; see {@link NZ_PRIVATE_BOX_ALIAS} and operator ruling 2026-06-11). Callers that want only
 * formally-valid ADV358 types should check `!result.colloquial`.
 */
export function matchNzDeliveryService(input: unknown): NzDeliveryServiceMatch | null {
	if (typeof input !== "string") return null

	for (const { type, re } of MATCHERS) {
		const m = re.exec(input)

		if (!m) continue
		const colloquial = type === "Private Box" ? ({ colloquial: true } as const) : {}

		return { matched: m[1]!.trim(), type, ...(m[2] ? { id: m[2] } : {}), ...colloquial }
	}

	return null
}

/** Type-predicate: does the input look like a standalone NZ delivery-service address line? */
export function isNzDeliveryService(input: unknown): boolean {
	return matchNzDeliveryService(input) !== null
}

/**
 * Normalize a recognized phrase to the ADV358 form (`"p.o. box 24999"` → `"PO Box 24999"`). Returns the input unchanged
 * if it isn't a delivery-service phrase.
 */
export function normalizeNzDeliveryService(input: string): string {
	const m = matchNzDeliveryService(input)

	if (!m) return input

	return m.id ? `${m.type} ${m.id.toUpperCase()}` : m.type
}
