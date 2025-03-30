// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A resource with a display name.
 */
export interface Displayable {
	displayName?: string
}

export type WithDisplayable<T> = T & Displayable

/**
 * Type predicate to determine if a value is displayable.
 */
export function isDisplayable(value: unknown): value is Displayable {
	return typeof value === "object" && value !== null && "displayName" in value
}
