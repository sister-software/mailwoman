// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `CopyButton` — a small presentational button that copies a string and shows a transient checkmark.
 *   Wraps {@link useClipboard}. Used by both explorers (OverpassQL copy, parse-JSON copy).
 */

import type { ReactNode } from "react"

import { useClipboard } from "./useClipboard.ts"

export interface CopyButtonProps {
	/**
	 * The text to copy. If a thunk, it's evaluated at click time (so callers can copy the latest value).
	 */
	value: string | (() => string)
	/**
	 * Label in the idle state. @default "Copy"
	 */
	label?: ReactNode
	/**
	 * Label shown briefly after a successful copy. @default "✓ Copied"
	 */
	copiedLabel?: ReactNode
	className?: string
	disabled?: boolean
}

export function CopyButton({
	value,
	label = "Copy",
	copiedLabel = "✓ Copied",
	className = "mw-btn",
	disabled,
}: CopyButtonProps): ReactNode {
	const { copied, copy } = useClipboard()

	return (
		<button
			type="button"
			className={className}
			disabled={disabled}
			onClick={() => copy(typeof value === "function" ? value() : value)}
		>
			{copied ? copiedLabel : label}
		</button>
	)
}
