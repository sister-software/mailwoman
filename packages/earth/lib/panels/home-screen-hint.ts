// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Whether the cache panel suggests adding Earth to the Home Screen.
 *
 *   iOS shows no install prompt of its own.
 *   A site added to the Home Screen keeps its storage outside Safari's seven-day
 *   eviction of script-written data, so the offline copy lasts longer.
 */

import { isAppleTouchDevice } from "#memory/device-tier"

/**
 * The browser readings the hint is chosen from.
 */
export interface HomeScreenSignals {
	userAgent: string
	maxTouchPoints: number
	/**
	 * Whether `(display-mode: standalone)` matches or Safari's `navigator.standalone` is set,
	 * as they are once the page runs from the Home Screen.
	 */
	standalone: boolean
}

/**
 * The user-agent tokens of other iOS browsers.
 * Each browser adds its token beside Safari's own.
 */
const OTHER_IOS_BROWSERS = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//

/**
 * Whether to show the Home Screen hint: Safari on an iPhone, iPod or iPad, outside the Home Screen app.
 */
export function wantsHomeScreenHint({ userAgent, maxTouchPoints, standalone }: HomeScreenSignals): boolean {
	return (
		!standalone &&
		isAppleTouchDevice(userAgent, maxTouchPoints) &&
		/Safari\//.test(userAgent) &&
		!OTHER_IOS_BROWSERS.test(userAgent)
	)
}

/**
 * Reads {@link HomeScreenSignals} from the page's globals.
 */
export function readHomeScreenSignals(): HomeScreenSignals {
	const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined

	return {
		userAgent: nav?.userAgent ?? "",
		maxTouchPoints: nav?.maxTouchPoints ?? 0,
		standalone: nav?.standalone === true || (globalThis.matchMedia?.("(display-mode: standalone)").matches ?? false),
	}
}
