/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The character band: the traced text drawn one character at a time, each in the color of the label of the
 *   token covering it, with the token's confidence as the color's weight. A character between tokens, such as
 *   the space SentencePiece folds into the next piece, is drawn plain, and a newline breaks the band's line.
 */

import type { TraceTokenLike } from "mailwoman/browser-runtime/types"
import React, { useMemo } from "react"

import { coveringTokenIndex, familyOrder, labelFamily, labelHue } from "./helpers.ts"

import styles from "./styles.module.css"

export interface CharacterBandProps {
	text: string
	tokens: readonly TraceTokenLike[]
	/**
	 * The model's label list.
	 * Its order fixes each family's hue.
	 */
	labels: readonly string[]
}

/**
 * Renders every character of `text` under the label of the token whose `[start, end)` span holds it.
 */
export function CharacterBand({ text, tokens, labels }: CharacterBandProps): React.JSX.Element {
	const order = useMemo(() => familyOrder(labels), [labels])
	const characters = [...text]

	return (
		<div className={styles.charBand} aria-label="Characters by label">
			{characters.map((character, offset) => {
				if (character === "\n") {
					return <span key={offset} className={styles.charBreak} />
				}

				const index = coveringTokenIndex(tokens, offset)
				const token = index === -1 ? null : tokens[index]!
				const hue = token ? labelHue(token.label, order) : null

				if (!token || hue === null) {
					return (
						<span key={offset} className={styles.char} data-o={token ? "" : undefined}>
							{character === " " ? " " : character}
						</span>
					)
				}

				return (
					<span
						key={offset}
						className={styles.char}
						data-family={labelFamily(token.label)}
						title={`${token.label} ${(token.confidence * 100).toFixed(0)}%`}
						style={{
							// The hue is the family; the confidence sets how much of the family's color shows.
							backgroundColor: `hsl(${hue} 70% 50% / ${(0.2 + 0.6 * token.confidence).toFixed(2)})`,
						}}
					>
						{character === " " ? " " : character}
					</span>
				)
			})}
		</div>
	)
}
