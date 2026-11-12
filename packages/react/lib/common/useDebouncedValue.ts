// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `useDebouncedValue` — returns a copy of `value` that only updates after `delayMs` of quiet.
 *
 *   Used by the POI explorer to avoid re-classifying on every keystroke.
 *   The timer is an external-sync effect (a scheduled clock), so it belongs in an effect.
 */

import { useEffect, useState } from "react"

export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value)

	useEffect(() => {
		const id = setTimeout(() => setDebounced(value), delayMs)

		return () => clearTimeout(id)
	}, [value, delayMs])

	return debounced
}
