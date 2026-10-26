/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every country's postal designator table, and the lookup by country.
 *
 *   Each table lives in its country's directory as `lib/<cc>/designators.ts`. This module only collects them,
 *   so a reader that needs every country's designators, such as a vocabulary sample or a collision report,
 *   reads one list.
 */

import { AE_POSTAL_DESIGNATORS } from "#ae/designators"
import { AR_POSTAL_DESIGNATORS } from "#ar/designators"
import { AT_POSTAL_DESIGNATORS } from "#at/designators"
import { AU_POSTAL_DESIGNATORS } from "#au/designators"
import { BE_POSTAL_DESIGNATORS } from "#be/designators"
import { BR_POSTAL_DESIGNATORS } from "#br/designators"
import { CA_POSTAL_DESIGNATORS } from "#ca/designators"
import { CH_POSTAL_DESIGNATORS } from "#ch/designators"
import { CL_POSTAL_DESIGNATORS } from "#cl/designators"
import { CN_POSTAL_DESIGNATORS } from "#cn/designators"
import { CR_POSTAL_DESIGNATORS } from "#cr/designators"
import { DE_POSTAL_DESIGNATORS } from "#de/designators"
import { DK_POSTAL_DESIGNATORS } from "#dk/designators"
import { EG_POSTAL_DESIGNATORS } from "#eg/designators"
import { ES_POSTAL_DESIGNATORS } from "#es/designators"
import { FI_POSTAL_DESIGNATORS } from "#fi/designators"
import { FR_POSTAL_DESIGNATORS } from "#fr/designators"
import { GB_POSTAL_DESIGNATORS } from "#gb/designators"
import { HK_POSTAL_DESIGNATORS } from "#hk/designators"
import { ID_POSTAL_DESIGNATORS } from "#id/designators"
import { IE_POSTAL_DESIGNATORS } from "#ie/designators"
import { IL_POSTAL_DESIGNATORS } from "#il/designators"
import { IT_POSTAL_DESIGNATORS } from "#it/designators"
import { JP_POSTAL_DESIGNATORS } from "#jp/designators"
import { KR_POSTAL_DESIGNATORS } from "#kr/designators"
import { MX_POSTAL_DESIGNATORS } from "#mx/designators"
import { MY_POSTAL_DESIGNATORS } from "#my/designators"
import { NI_POSTAL_DESIGNATORS } from "#ni/designators"
import { NL_POSTAL_DESIGNATORS } from "#nl/designators"
import { NO_POSTAL_DESIGNATORS } from "#no/designators"
import { NZ_POSTAL_DESIGNATORS } from "#nz/designators"
import { PL_POSTAL_DESIGNATORS } from "#pl/designators"
import { foldDesignatorSpelling, type PostalDesignatorRow, type PostalDesignatorTable } from "#postal-designator"
import { PT_POSTAL_DESIGNATORS } from "#pt/designators"
import { RU_POSTAL_DESIGNATORS } from "#ru/designators"
import { SA_POSTAL_DESIGNATORS } from "#sa/designators"
import { SE_POSTAL_DESIGNATORS } from "#se/designators"
import { SG_POSTAL_DESIGNATORS } from "#sg/designators"
import { TR_POSTAL_DESIGNATORS } from "#tr/designators"
import { TW_POSTAL_DESIGNATORS } from "#tw/designators"
import { UA_POSTAL_DESIGNATORS } from "#ua/designators"
import { US_POSTAL_DESIGNATORS } from "#us/designators"
import { ZA_POSTAL_DESIGNATORS } from "#za/designators"

/**
 * Every country's designator table, in ISO 3166-1 alpha-2 order.
 */
export const POSTAL_DESIGNATOR_TABLES: readonly PostalDesignatorTable[] = [
	AE_POSTAL_DESIGNATORS,
	AR_POSTAL_DESIGNATORS,
	AT_POSTAL_DESIGNATORS,
	AU_POSTAL_DESIGNATORS,
	BE_POSTAL_DESIGNATORS,
	BR_POSTAL_DESIGNATORS,
	CA_POSTAL_DESIGNATORS,
	CH_POSTAL_DESIGNATORS,
	CL_POSTAL_DESIGNATORS,
	CN_POSTAL_DESIGNATORS,
	CR_POSTAL_DESIGNATORS,
	DE_POSTAL_DESIGNATORS,
	DK_POSTAL_DESIGNATORS,
	EG_POSTAL_DESIGNATORS,
	ES_POSTAL_DESIGNATORS,
	FI_POSTAL_DESIGNATORS,
	FR_POSTAL_DESIGNATORS,
	GB_POSTAL_DESIGNATORS,
	HK_POSTAL_DESIGNATORS,
	ID_POSTAL_DESIGNATORS,
	IE_POSTAL_DESIGNATORS,
	IL_POSTAL_DESIGNATORS,
	IT_POSTAL_DESIGNATORS,
	JP_POSTAL_DESIGNATORS,
	KR_POSTAL_DESIGNATORS,
	MX_POSTAL_DESIGNATORS,
	MY_POSTAL_DESIGNATORS,
	NI_POSTAL_DESIGNATORS,
	NL_POSTAL_DESIGNATORS,
	NO_POSTAL_DESIGNATORS,
	NZ_POSTAL_DESIGNATORS,
	PL_POSTAL_DESIGNATORS,
	PT_POSTAL_DESIGNATORS,
	RU_POSTAL_DESIGNATORS,
	SA_POSTAL_DESIGNATORS,
	SE_POSTAL_DESIGNATORS,
	SG_POSTAL_DESIGNATORS,
	TR_POSTAL_DESIGNATORS,
	TW_POSTAL_DESIGNATORS,
	UA_POSTAL_DESIGNATORS,
	US_POSTAL_DESIGNATORS,
	ZA_POSTAL_DESIGNATORS,
]

const BY_COUNTRY = new Map(POSTAL_DESIGNATOR_TABLES.map((table) => [table.country, table]))

const LETTER = /\p{L}/u

/**
 * Returns the rows of `table` whose spelling or an abbreviation occurs in `text`.
 *
 * A spelling that starts or ends with a letter must meet a non-letter on that side,
 * so `Rm` matches `Rm 12` and does not match inside `Rmx`.
 * A spelling of symbols, such as `#` or `/F`, matches wherever it occurs.
 *
 * The match folds case, periods and whitespace as {@linkcode foldDesignatorSpelling} does.
 */
export function designatorsInText(text: string, table: PostalDesignatorTable): PostalDesignatorRow[] {
	const folded = foldDesignatorSpelling(text)

	return table.rows.filter((row) =>
		[row.spelling, ...row.abbreviations].some((spelling) => {
			const needle = foldDesignatorSpelling(spelling)

			if (!needle) return false

			for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + 1)) {
				const before = folded[at - 1] ?? " "
				const after = folded[at + needle.length] ?? " "
				const startsLetter = LETTER.test(needle[0]!)
				const endsLetter = LETTER.test(needle.at(-1)!)

				if ((!startsLetter || !LETTER.test(before)) && (!endsLetter || !LETTER.test(after))) return true
			}

			return false
		})
	)
}

/**
 * Returns a country's designator table, or `null` when the codex holds none for it.
 */
export function designatorTableFor(country: string): PostalDesignatorTable | null {
	return BY_COUNTRY.get(country.toUpperCase()) ?? null
}
