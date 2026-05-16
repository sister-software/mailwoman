/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A resource with a display name.
 */
export type Displayable<T> = T & {
	displayName?: string
}

/**
 * Type predicate to determine if a value is displayable.
 */
export function isDisplayable<T>(value: T): value is Displayable<T> {
	return typeof value === "object" && value !== null && "displayName" in value
}
