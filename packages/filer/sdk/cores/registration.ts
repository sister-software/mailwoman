/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @file cores registration page parsing.
 */

import { extractTableRows } from "@mailwoman/core/html/tables"

import type { FRN } from "#frn"

/**
 * One cores registration record exactly as the detail page states it.
 *
 * Every field is optional because the page omits a row instead of emitting an empty one.
 * The reader does not interpret, derive or classify fields.
 */
export interface CORESRegistration {
	frn: FRN
	/**
	 * The legal name under which the entity registered.
	 * People may use a different name.
	 */
	entityName: string | null
	/**
	 * Cores's own entity-type string verbatim, deliberately not parsed into a union
	 * because the vocabulary is unenumerated.
	 */
	entityType: string | null
	/**
	 * The organization the registered contact belongs to, a genuinely independent name surface
	 * from `entityName` because it is where the brand appears when it differs from the legal name.
	 */
	contactOrganization: string | null
	contactName: string | null
	contactPosition: string | null
	/**
	 * The contact's postal address as one string, with cores's line breaks
	 * and appended `"United States"` collapsed.
	 */
	contactAddress: string | null
	contactEmail: string | null
	contactPhone: string | null
	contactFax: string | null
	/**
	 * Raw `MM/DD/yyyy hh:mm:ss AM/PM` timestamps exactly as served, so a caller that
	 * needs a temporal value performs its own conversion to a `Date`.
	 */
	registrationDate: string | null
	lastUpdated: string | null
}

/**
 * Maps a cores row label to its {@linkcode CORESRegistration} field, keyed on the normalized
 * label so the page's `"ContactPhone:"` and `"Contact Phone:"` variants land on one key.
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
 * Tokens kept upper-case through the title-casing pass — only initialisms whose conventional rendering
 * is all-caps, matched on the token with trailing punctuation stripped so `LLC,` and `LLC.` both hit.
 */
const UPPERCASE_TOKENS = new Set(["llc", "lc", "lp", "llp", "pllc", "pc", "pa", "usa", "us", "dba", "inc's"])

/**
 * Title-cases a value that arrived uniformly cased, leaving mixed-case values
 * and values containing `:`, `@`, `(`, `)` or `-` without changing them.
 *
 * It is a display-level tidy, so anything joining on these values must still
 * go through `canonicalizeOrganizationName`.
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
 * Parses a cores `searchDetail.do` page into a {@linkcode CORESRegistration},
 * returning `null` — never a stub and never a throw — when no recognizable table is present
 * or the page's own `FRN:` row disagrees with the requested FRN.
 * A stub would silently write a false identity link.
 */
export function parseCORESRegistration(frn: FRN, html: string): CORESRegistration | null {
	const fields: Partial<Record<keyof CORESRegistration, string>> = {}

	// The page states one label/value pair per row.
	// Read as a grid rather than by pattern: `/<td[^>]*>([\s\S]*?)<\/td>/` over a
	// network-supplied page backtracks polynomially on a body with many `<td` repetitions
	// and no closing partner (CodeQL `js/polynomial-redos`), and the parser answers the
	// same question without a scan that can be made to spend the document.
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

	const registration: CORESRegistration = {
		frn,
		entityName: null,
		entityType: null,
		contactOrganization: null,
		contactName: null,
		contactPosition: null,
		contactAddress: null,
		contactEmail: null,
		contactPhone: null,
		contactFax: null,
		registrationDate: null,
		lastUpdated: null,
	}

	for (const [field, value] of Object.entries(fields)) {
		if (field === "frn") continue

		registration[field as Exclude<keyof CORESRegistration, "frn">] =
			field === "entityName" || field === "contactOrganization" || field === "contactName"
				? recaseUniform(value)
				: value
	}

	return registration
}
