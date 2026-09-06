// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { setTimeout } from "node:timers/promises"

/**
 * Resolve after `milliseconds`, or reject with the signal's reason when `signal` aborts first — a backoff step, a
 * politeness pause between requests.
 */
export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return setTimeout(milliseconds, undefined, { signal })
}
