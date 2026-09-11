/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @file CORES registration page parsing.
 */

import { extractTableRows } from "@mailwoman/core/html/tables"

import type { FRN } from "#frn"

/**
 * One CORES registration record, exactly as the detail page states it. Every field is optional because the page omits a
 * row rather than emitting an empty one, and an absent contact fax says nothing about the entity.
 *
 * No field here is interpreted, derived or classified — see the file header's note 2 on why Nexus's name-sniffing
 * classification is not carried over.
 */
export interface CORESRegistration {
	frn: FRN
	/**
	 * The legal name the entity registered under. NOT necessarily the name anyone uses for it: FRN `0001753557` registers
	 * as `"Knology Total Communications, Inc."` while operating as WOW!.
	 */
	entityName?: string
	/**
	 * CORES's own entity-type string, verbatim (e.g. `"Private Sector , Corporation"` — the stray space before the comma
	 * is in the source). Deliberately not parsed into a union: the vocabulary is unenumerated and a caller that needs a
	 * classification should corroborate rather than trust a string split.
	 */
	entityType?: string
	/**
	 * The organization the registered contact belongs to. In practice this is where the BRAND appears when it differs
	 * from the legal name — `"WOW! Internet, Cable and Phone"` against a legal name of `"Knology Total Communications,
	 * Inc."` — which makes it a genuinely independent name surface, not a duplicate of `entityName`.
	 */
	contactOrganization?: string
	contactName?: string
	contactPosition?: string
	/**
	 * The contact's postal address as one string. CORES renders it across several lines and appends `"United States"`;
	 * both are collapsed here, the country suffix included, since every record in scope is domestic and keeping it adds a
	 * token every address-matching pass would have to strip again.
	 */
	contactAddress?: string
	contactEmail?: string
	contactPhone?: string
	contactFax?: string
	/**
	 * Raw `MM/DD/YYYY hh:mm:ss AM/PM` timestamps exactly as served. NOT parsed to a `Date` here — the same discipline
	 * `Form499Row.lastFiledAt` follows, so a caller that needs a temporal value performs (and can validate) its own
	 * conversion rather than inheriting a silent one.
	 */
	registrationDate?: string
	lastUpdated?: string
}

/**
 * Maps a CORES row label to its {@linkcode CORESRegistration} field. Keyed on the label reduced to lowercase letters and
 * digits only, so `"ContactPhone:"` and `"Contact Phone:"` — the page ships both spellings, the phone and fax rows
 * having lost their space — land on one key without a separate alias per variant.
 */
const FIELD_BY_LABEL: Record<string, keyof CORESRegistration> = {
	frn: "frn",
	registrationdate: "registrationDate",
	lastupdated: "lastUpdated",
	entityname: "entityName",
	entitytype: "entityType",
	contactorganization: "contactOrganization",
	contactposition: "contactPosition",
	contactname: "contactName",
	contactaddress: "contactAddress",
	contactemail: "contactEmail",
	contactphone: "contactPhone",
	contactfax: "contactFax",
}

function labelKey(text: string): string {
	return text.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

const HAS_LOWERCASE_PATTERN = /[a-z]/
const HAS_UPPERCASE_PATTERN = /[A-Z]/
const CASE_SENSITIVE_PUNCTUATION_PATTERN = /[:@()-]/

/**
 * Tokens that stay upper-case through the title-casing pass. Without these, `COMCAST CABLE COMMUNICATIONS, LLC`
 * title-cases to `… , Llc`, which is not a spelling anyone uses and would reach a product surface verbatim.
 *
 * Deliberately only initialisms whose conventional rendering IS all-caps. `Ltd`, `Corp` and `Inc` are absent because
 * their conventional rendering is title case, which the pass already produces. Matched on the token with trailing
 * punctuation stripped, so `LLC,` and `LLC.` both hit.
 */
const UPPERCASE_TOKENS = new Set(["llc", "lc", "lp", "llp", "pllc", "pc", "pa", "usa", "us", "dba", "inc's"])

/**
 * Title-case a value that arrived UNIFORMLY cased, and leave everything else alone — Nexus's `normalizeDataCell` idea,
 * kept because FCC data mixes `WINDSTREAM SERVICES LLC` with `Lumen Technologies Inc.` in the same column.
 *
 * The guard is what makes it safe. A string carrying BOTH cases is already deliberately cased and is returned
 * untouched, so `WOW! Internet, Cable and Phone` survives. A string containing `:`, `@`, `(`, `)` or `-` is left alone
 * too: those mark addresses, emails and phone numbers, where re-casing corrupts rather than tidies. Entity-form
 * initialisms are restored to upper case afterwards ({@linkcode UPPERCASE_TOKENS}).
 *
 * This is a display-level tidy, NOT a matching normalizer. Anything joining on these values must still go through
 * `canonicalizeOrganizationName` — re-casing does not fold `INC` and `Inc.` together.
 */
export function recaseUniform(value: string): string {
	if (CASE_SENSITIVE_PUNCTUATION_PATTERN.test(value)) return value

	const hasLower = HAS_LOWERCASE_PATTERN.test(value)
	const hasUpper = HAS_UPPERCASE_PATTERN.test(value)

	if (hasLower && hasUpper) return value

	if (!hasLower && !hasUpper) return value

	return value
		.toLowerCase()
		.replaceAll(/(^|\s|["'([])([a-z])/g, (_match, prefix: string, letter: string) => prefix + letter.toUpperCase())
		.replaceAll(/\S+/g, (token) =>
			UPPERCASE_TOKENS.has(token.toLowerCase().replaceAll(/[^a-z']/g, "")) ? token.toUpperCase() : token
		)
}

/**
 * Parse a CORES `searchDetail.do` page into a {@linkcode CORESRegistration}.
 *
 * Returns `null` — never a stub record, and never a throw — when the page carries no recognizable registration table,
 * or when its `FRN:` row disagrees with the FRN that was requested. Both are ordinary: CORES serves a search form for
 * an unknown FRN, and an abstention here is a fact the caller counts, not an error it handles.
 *
 * **The FRN cross-check is the required part.** Without it a page served for the wrong entity — a redirect, a cached
 * response for a different query, a truncated document — would be attributed to the FRN that was asked for, which is a
 * false identity link written silently. The page states its own FRN; requiring the two to agree is free.
 */
export function parseCORESRegistration(frn: FRN, html: string): CORESRegistration | null {
	const fields: Partial<Record<keyof CORESRegistration, string>> = {}

	// The page states one label/value pair per row. Read as a GRID rather than by pattern: `/<td[^>]*>([\s\S]*?)<\/td>/`
	// over a network-supplied page backtracks polynomially on a body with many `<td` repetitions and no closing partner
	// (CodeQL `js/polynomial-redos`), and the parser answers the same question without a scan that can be made to spend
	// the document.
	for (const rows of extractTableRows(html) ?? []) {
		for (const row of rows) {
			const label = row.find((cell) => cell.tag === "th")?.text

			if (!label) continue

			const field = FIELD_BY_LABEL[labelKey(label)]

			if (!field) continue

			const value = row.find((cell) => cell.tag === "td")?.text

			if (value) {
				fields[field] = value
			}
		}
	}

	if (!fields.entityName && !fields.contactOrganization) return null

	if (fields.frn && fields.frn !== frn) return null

	const registration: CORESRegistration = { frn }

	for (const [field, value] of Object.entries(fields)) {
		if (field === "frn") continue

		// Timestamps and free-text contact details keep their source casing; only the NAME surfaces get the
		// uniform-case tidy, since they are what a human reads and what a display layer renders.
		registration[field as Exclude<keyof CORESRegistration, "frn">] =
			field === "entityName" || field === "contactOrganization" || field === "contactName"
				? recaseUniform(value)
				: value
	}

	return registration
}
