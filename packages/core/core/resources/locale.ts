// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Format a quantity for display.
 */
export const formatQuantity = (quantity: number) => {
	return quantity.toLocaleString("en-US", {
		maximumFractionDigits: 2,
	})
}

/**
 * Format a duration for display.
 */
export const formatMinutes = (minutes: number) => {
	return minutes.toLocaleString("en-US", {
		maximumFractionDigits: 2,
	})
}
