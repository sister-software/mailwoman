/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The three-register board instrument the anchor-v2 board family shares: the register axis, the grading fold,
 *   and the per-register hit/total board with its report line.
 */

/**
 * The register axis the #690 case-normalization work made required: as-written, lowercase, UPPERCASE.
 */
export const REGISTERS = ["asis", "lower", "upper"] as const

export type Register = (typeof REGISTERS)[number]

/**
 * Project a query into one register.
 */
export function register(text: string, reg: Register): string {
	return reg === "lower" ? text.toLowerCase() : reg === "upper" ? text.toUpperCase() : text
}

/**
 * The grading fold: uppercase, all whitespace removed.
 */
export const fold = (value: string): string => value.toUpperCase().replaceAll(/\s+/gu, "")

/**
 * One tag's board over a row set × the three registers.
 */
export interface Board {
	perRegister: Record<Register, { hit: number; total: number }>
}

export function emptyBoard(): Board {
	return {
		perRegister: {
			asis: { hit: 0, total: 0 },
			lower: { hit: 0, total: 0 },
			upper: { hit: 0, total: 0 },
		},
	}
}

/**
 * Print one board line: the pooled hit/total, then the per-register split, then any caller suffix.
 */
export function reportBoard(name: string, board: Board, suffix = ""): void {
	const hit = REGISTERS.reduce((sum, r) => sum + board.perRegister[r].hit, 0)
	const total = REGISTERS.reduce((sum, r) => sum + board.perRegister[r].total, 0)

	console.log(
		`${name.padEnd(34)} ${`${hit}/${total}`.padStart(9)}   ` +
			REGISTERS.map((r) => `${r} ${board.perRegister[r].hit}/${board.perRegister[r].total}`).join(" · ") +
			suffix
	)
}
