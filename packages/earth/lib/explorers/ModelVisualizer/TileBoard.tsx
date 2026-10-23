/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The tile board: the input's words as tiles the visitor drags into a new order or removes, the way word
 *   magnets on a fridge are rearranged. Each change rewrites the traced text, so the bands and readings
 *   follow the permutation. A probe traces the text once per tile with that tile removed and shows which
 *   other tokens changed label. That list is the confoundance reading under permutation.
 */

import React, { useState } from "react"

import type { LabelFlip } from "./helpers.ts"

import styles from "./styles.module.css"

export interface TileBoardProps {
	tiles: readonly string[]
	/**
	 * Per tile, the label flips its removal caused in the last probe, or `null` before a probe of this text.
	 */
	flips: ReadonlyArray<readonly LabelFlip[]> | null
	probing: boolean
	onMove: (from: number, to: number) => void
	onRemove: (index: number) => void
	onReset: () => void
	onProbe: () => void
}

export function TileBoard({
	tiles,
	flips,
	probing,
	onMove,
	onRemove,
	onReset,
	onProbe,
}: TileBoardProps): React.JSX.Element {
	const [dragging, setDragging] = useState<number | null>(null)

	return (
		<div className={styles.tileBoard} aria-label="Tiles">
			<div className={styles.tileRow}>
				{tiles.map((tile, index) => {
					const tileFlips = flips?.[index] ?? null

					return (
						<span
							key={`${index}-${tile}`}
							className={styles.tile}
							draggable
							data-dragging={dragging === index || undefined}
							data-flips={tileFlips ? Math.min(tileFlips.length, 3) : undefined}
							title={tileFlips ? `${tileFlips.length} label flips when removed` : undefined}
							onDragStart={() => setDragging(index)}
							onDragEnd={() => setDragging(null)}
							onDragOver={(event) => event.preventDefault()}
							onDrop={(event) => {
								event.preventDefault()

								if (dragging !== null && dragging !== index) {
									onMove(dragging, index)
								}

								setDragging(null)
							}}
						>
							<button
								type="button"
								className={styles.tileButton}
								aria-label={`Move ${tile} left`}
								disabled={index === 0}
								onClick={() => onMove(index, index - 1)}
							>
								‹
							</button>
							<span className={styles.tileWord}>{tile}</span>
							{tileFlips ? <span className={styles.tileCount}>{tileFlips.length}</span> : null}
							<button
								type="button"
								className={styles.tileButton}
								aria-label={`Move ${tile} right`}
								disabled={index === tiles.length - 1}
								onClick={() => onMove(index, index + 1)}
							>
								›
							</button>
							<button
								type="button"
								className={styles.tileButton}
								aria-label={`Remove ${tile}`}
								onClick={() => onRemove(index)}
							>
								×
							</button>
						</span>
					)
				})}
			</div>

			<div className={styles.tileActions}>
				<button type="button" className={styles.traceButton} onClick={onProbe} disabled={probing || tiles.length < 2}>
					{probing ? "Probing…" : "Probe each tile's removal"}
				</button>
				<button type="button" className={styles.tileReset} onClick={onReset}>
					Reset to the typed text
				</button>
			</div>

			{flips ? (
				<ul className={styles.readingList}>
					{tiles.map((tile, index) => {
						const tileFlips = flips[index] ?? []

						if (!tileFlips.length) return null

						return (
							<li key={`${index}-${tile}`}>
								<code>{tile}</code> removed:{" "}
								{tileFlips.map((flip) => `${flip.piece.replaceAll("▁", "␣")} ${flip.before}→${flip.after}`).join(", ")}
							</li>
						)
					})}
				</ul>
			) : null}
		</div>
	)
}
