import { useCallback, useState } from "react"

import styles from "./styles.module.css"

/**
 * Copy a `https://mailwoman.sister.software/demo/?q=<encoded>` link to clipboard. Falls back to a transient textarea
 * hack on older browsers (Safari < 13.4 still misbehaves with the async Clipboard API in non-secure contexts). Visible
 * feedback is a 1.5s checkmark swap so the operator knows the click landed.
 */
export const PermalinkButton: React.FC<{ text: string }> = ({ text }) => {
	const [copied, setCopied] = useState(false)

	const onClick = useCallback(async () => {
		if (typeof window === "undefined") return
		const url = new URL(window.location.href)

		if (text) {
			url.searchParams.set("q", text)
		} else {
			url.searchParams.delete("q")
		}
		const href = url.toString()

		try {
			await navigator.clipboard.writeText(href)
		} catch {
			const ta = document.createElement("textarea")
			ta.value = href
			ta.style.position = "fixed"
			ta.style.opacity = "0"
			document.body.appendChild(ta)
			ta.select()

			try {
				document.execCommand("copy")
			} catch {
				/* nothing more we can do; user can copy from address bar */
			}
			document.body.removeChild(ta)
		}
		setCopied(true)
		window.setTimeout(() => setCopied(false), 1500)
	}, [text])

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
