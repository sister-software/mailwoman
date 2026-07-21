/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useCompareState` — the small headless state machine behind the demo's compare toggle
 *   (`_app.tsx:142-143, 1238-1305`): whether compare mode is on, and which version to compare against.
 *   Turning compare off clears the chosen version; selecting a compare version equal to the primary is
 *   rejected (the picker filters it out, this guards the programmatic path). The SECOND parse itself is a
 *   host concern surfaced through `panels.compare` — this hook owns only the toggle + selection.
 */

import { useCallback, useState } from "react"

export interface UseCompareState {
	/** Whether compare mode is on. */
	compareMode: boolean
	/** The version chosen to compare against, or `null`. */
	compareVersion: string | null
	/** Flip compare mode; turning it off clears the chosen version. */
	setCompareMode: (compareMode: boolean) => void
	/** Choose a compare version (`null` clears it). */
	setCompareVersion: (version: string | null) => void
	/** Keep the compare selection distinct from the primary — call when the primary version changes. */
	clearIfPrimary: (primaryVersion: string) => void
}

export function useCompareState(): UseCompareState {
	const [compareMode, setCompareModeState] = useState(false)
	const [compareVersion, setCompareVersion] = useState<string | null>(null)

	const setCompareMode = useCallback((next: boolean) => {
		setCompareModeState(next)

		if (!next) {
			setCompareVersion(null)
		}
	}, [])

	const clearIfPrimary = useCallback((primaryVersion: string) => {
		setCompareVersion((prev) => (prev === primaryVersion ? null : prev))
	}, [])

	return { compareMode, compareVersion, setCompareMode, setCompareVersion, clearIfPrimary }
}
