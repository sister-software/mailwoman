// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
