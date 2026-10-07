/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shapes that stand beside each state's color. Each glyph is decoration for a word the page also writes, so
 *   every glyph is hidden from assistive technology and the word states the fact.
 *
 *   The two unknown states draw a dashed outline around a question mark, a circle for unknown coverage and a
 *   diamond for an unknown unit count. A selected building's glyph draws a heavier outline and a check mark. A
 *   verified segment is a solid line, a proposed segment a dashed line, and a shared segment a wider line.
 */

import { BuildingState, SegmentStatus } from "@mailwoman/opportunity-map"
import type { ReactNode } from "react"

const OUTLINE = 2
const SELECTED_OUTLINE = 4
const DASHES = "3.2 2.4"

/**
 * The shape of one building state, with the check mark and heavier outline of a selected building.
 */
export function StateGlyph({
	state,
	selected = false,
	size = 18,
}: {
	state: BuildingState
	selected?: boolean
	size?: number
}): ReactNode {
	const stroke = selected ? SELECTED_OUTLINE : OUTLINE
	const unknown = state === BuildingState.UnknownCoverage || state === BuildingState.UnknownUnitCount

	const shape = (() => {
		switch (state) {
			case BuildingState.PartialAvailability:
				return (
					<>
						<circle cx="12" cy="12" r="8.5" fill="var(--glyph-paper)" strokeWidth={stroke} />
						<path d="M12 3.5 A8.5 8.5 0 0 0 12 20.5 Z" fill="currentColor" stroke="none" />
					</>
				)
			case BuildingState.KnownUnserved:
				return (
					<>
						<circle cx="12" cy="12" r="8.5" fill="var(--glyph-paper)" strokeWidth={stroke} />
						<path d="M6 18 L18 6" strokeWidth={stroke} />
					</>
				)
			case BuildingState.ZeroPremises:
				return <rect x="4" y="4" width="16" height="16" fill="var(--glyph-paper)" strokeWidth={stroke} />
			case BuildingState.UnknownCoverage:
				return (
					<circle cx="12" cy="12" r="8.5" fill="var(--glyph-paper)" strokeWidth={stroke} strokeDasharray={DASHES} />
				)
			case BuildingState.UnknownUnitCount:
				return (
					<path
						d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z"
						fill="var(--glyph-paper)"
						strokeWidth={stroke}
						strokeDasharray={DASHES}
					/>
				)
		}
	})()

	return (
		<svg
			className={`glyph glyph--${state}${selected ? " glyph--selected" : ""}`}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			<g stroke="currentColor" strokeLinejoin="round">
				{shape}
			</g>
			{unknown ? <QuestionMark /> : null}
			{selected ? <CheckMark /> : null}
		</svg>
	)
}

/**
 * The question mark inside the two unknown states' outlines, drawn as a path
 * so the glyph holds no text node.
 */
function QuestionMark(): ReactNode {
	return (
		<g className="glyph__question" stroke="currentColor" fill="none" strokeLinecap="round">
			<path d="M9.6 9.6 A2.5 2.5 0 1 1 13.2 11.9 C12.4 12.3 12 12.8 12 13.7 L12 14.2" strokeWidth="2" />
			<circle cx="12" cy="17.1" r="0.6" strokeWidth="1.6" fill="currentColor" />
		</g>
	)
}

/**
 * The check mark of a selected building, drawn in the glyph's upper right corner.
 */
function CheckMark(): ReactNode {
	return (
		<g className="glyph__check">
			<circle cx="19" cy="5" r="5" />
			<path d="M16.6 5.1 L18.4 6.9 L21.4 3.4" fill="none" strokeWidth="1.8" strokeLinecap="round" />
		</g>
	)
}

/**
 * A check mark on its own, beside the word selected.
 */
export function SelectedGlyph({ size = 16 }: { size?: number }): ReactNode {
	return (
		<svg
			className="glyph glyph--check"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M4 12.5 L9.5 18 L20 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
		</svg>
	)
}

/**
 * A line sample of a segment: solid when verified, dashed when proposed, wider when shared.
 */
export function SegmentGlyph({ status, shared = false }: { status: SegmentStatus; shared?: boolean }): ReactNode {
	return (
		<svg
			className={`glyph glyph--segment glyph--${status}`}
			width="32"
			height="12"
			viewBox="0 0 32 12"
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M2 6 L30 6"
				stroke="currentColor"
				strokeWidth={shared ? 6 : 3}
				strokeDasharray={status === SegmentStatus.Proposed ? "5 3" : undefined}
				strokeLinecap="butt"
			/>
		</svg>
	)
}
