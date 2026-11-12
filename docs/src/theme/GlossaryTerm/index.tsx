// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import GlossaryTerm from "@theme-original/GlossaryTerm"
import React, { useCallback, useEffect, useRef } from "react"

/**
 * The upstream glossary term with a touch-friendly first tap.
 *
 * The upstream component opens its tooltip on mouse enter or focus,
 * and its trigger is a link to the glossary entry.
 * A touch tap produces emulated mouse events, focus and a click in one gesture,
 * so the tooltip opens and the click navigates away before it can be read.
 *
 * This wrapper makes the first touch or pen tap on a term open the tooltip without following the link.
 * A second tap on the same open term follows it, and a tap anywhere else resets the term.
 *
 * Mouse clicks and keyboard activation follow the link as before.
 * A term without a definition has no tooltip, so every tap on it follows the link.
 *
 * After a tap, Chromium can dispatch an emulated `mouseout` from the term to
 * whatever element lies under the touch point.
 * The upstream component treats it as the pointer leaving and hides the tooltip.
 *
 * While a tap holds the tooltip open, the wrapper stops `mouseout` at its own element
 * so React never sees that leave.
 * The outside-tap reset runs on `pointerdown`, ahead of the next gesture's `mouseout`,
 * so a tap elsewhere still closes the tooltip.
 */
const GlossaryTermWrapper: React.FC<React.ComponentProps<typeof GlossaryTerm>> = (props) => {
	const wrapperRef = useRef<HTMLSpanElement>(null)
	// The pointer type of the gesture that produces the next click.
	const pointerTypeRef = useRef<string>("mouse")
	// Whether a touch tap has opened this term's tooltip and the next tap may follow the link.
	const openedByTapRef = useRef(false)

	useEffect(() => {
		const resetOnOutsideTap = (event: PointerEvent) => {
			if (!wrapperRef.current?.contains(event.target as Node)) {
				openedByTapRef.current = false
			}
		}

		const keepOpenAfterTap = (event: MouseEvent) => {
			if (openedByTapRef.current) {
				event.stopPropagation()
			}
		}

		const wrapper = wrapperRef.current

		document.addEventListener("pointerdown", resetOnOutsideTap, true)
		wrapper?.addEventListener("mouseout", keepOpenAfterTap, true)

		return () => {
			document.removeEventListener("pointerdown", resetOnOutsideTap, true)
			wrapper?.removeEventListener("mouseout", keepOpenAfterTap, true)
		}
	}, [])

	const onPointerDownCapture = useCallback((event: React.PointerEvent) => {
		pointerTypeRef.current = event.pointerType
	}, [])

	const onClickCapture = useCallback((event: React.MouseEvent) => {
		const tapped = pointerTypeRef.current === "touch" || pointerTypeRef.current === "pen"

		pointerTypeRef.current = "mouse"

		if (!tapped || openedByTapRef.current) return

		const wrapper = wrapperRef.current
		const link = wrapper?.querySelector("a")

		if (!wrapper?.querySelector('[role="tooltip"]') || !link) return

		event.preventDefault()
		openedByTapRef.current = true
		link.focus()
	}, [])

	return (
		<span
			ref={wrapperRef}
			className="glossary-term-wrapper"
			onPointerDownCapture={onPointerDownCapture}
			onClickCapture={onClickCapture}
		>
			<GlossaryTerm {...props} />
		</span>
	)
}

export default GlossaryTermWrapper
