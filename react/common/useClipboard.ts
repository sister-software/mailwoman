/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useClipboard` — headless copy-to-clipboard with the async Clipboard API and a legacy
 *   `execCommand` fallback (for insecure contexts / older browsers), plus a transient "copied" flag
 *   that auto-resets. Extracted from the two explorers' duplicated `onCopy` handlers.
 */

import { useCallback, useEffect, useRef, useState } from "react"

/** Best-effort clipboard write: async Clipboard API first, hidden-textarea `execCommand` fallback. */
async function writeToClipboard(value: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value)

		return
	} catch {
		// Fall through to the legacy path below.
	}

	const textarea = document.createElement("textarea")
	textarea.value = value
	textarea.style.position = "fixed"
	textarea.style.opacity = "0"
	document.body.appendChild(textarea)
	textarea.select()

	try {
		document.execCommand("copy")
	} catch {
		// Nothing else to try — leave `copied` false via the caller's error path.
	} finally {
		document.body.removeChild(textarea)
	}
}

export interface UseClipboard {
	copied: boolean
	copy: (value: string) => Promise<void>
}

/** @param resetMs - How long the `copied` flag stays true after a successful copy. */
export function useClipboard(resetMs = 1500): UseClipboard {
	const [copied, setCopied] = useState(false)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Clear a pending reset timer on unmount so it never fires against a torn-down component.
	useEffect(
		() => () => {
			if (timer.current) {
				clearTimeout(timer.current)
			}
		},
		[]
	)

	const copy = useCallback(
		async (value: string) => {
			await writeToClipboard(value)
			setCopied(true)

			if (timer.current) {
				clearTimeout(timer.current)
			}
			timer.current = setTimeout(() => setCopied(false), resetMs)
		},
		[resetMs]
	)

	return { copied, copy }
}
