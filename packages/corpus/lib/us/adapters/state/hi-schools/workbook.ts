/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { XLSXCellValue } from "spliterator"

/**
 * The two worksheets that together form the public-school directory.
 */
export const STATE_HI_SCHOOL_SHEETS = ["HIDOE", "PCS"] as const

/**
 * Columns required to construct a corpus row. Fetch validation uses the same contract as the adapter.
 */
export const STATE_HI_SCHOOL_REQUIRED_COLUMNS = ["code", "name", "address", "city", "zip"] as const

/**
 * Workbook row fields consumed by the adapter. XLSX cells are typed; the legacy CSV path supplies strings.
 */
export interface HiSchoolRow {
	code: XLSXCellValue | undefined
	name: XLSXCellValue | undefined
	address: XLSXCellValue | undefined
	city: XLSXCellValue | undefined
	zip: XLSXCellValue | undefined
}

/**
 * Convert a typed workbook cell or legacy CSV field to the trimmed text used by the corpus row.
 */
export function schoolCellText(value: XLSXCellValue | undefined): string {
	return value === null || value === undefined ? "" : String(value).trim()
}
