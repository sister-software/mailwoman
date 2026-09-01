/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Numeric helpers with no domain attached.
 */

/**
 * `value` limited to the closed interval `[min, max]`.
 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}
