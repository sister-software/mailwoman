import { useClipboard } from "@mailwoman/react"
import { useCallback } from "react"

import styles from "./styles.module.css"

/**
 * Copy a `https://mailwoman.ai/demo/?q=<encoded>` link to clipboard via the shared `useClipboard` (async Clipboard API
 * with a legacy `execCommand` fallback for older browsers). Visible feedback is a 1.5s checkmark swap so the operator
 * knows the click landed.
 */
export const PermalinkButton: React.FC<{ text: string }> = ({ text }) => {
	const { copied, copy } = useClipboard()

	const onClick = useCallback(async () => {
		if (globalThis.window === undefined) return
		const url = new URL(globalThis.location.href)

		if (text) {
			url.searchParams.set("q", text)
		} else {
			url.searchParams.delete("q")
		}

		await copy(url.toString())
	}, [text, copy])

	return (
		<button
			type="button"
			className={styles.permalinkBtn}
			onClick={onClick}
			title="Copy a shareable link to this address"
		>
			{copied ? "✓ Link copied" : "Copy link"}
		</button>
	)
}
