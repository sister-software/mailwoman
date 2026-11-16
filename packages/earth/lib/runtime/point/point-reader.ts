// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The point reader, imported when it is first needed.
 *
 *   `@mailwoman/spatial/point-reading` imports the recognition engine
 *   and the `coordinates`, `spatial` and `identifiers` artifacts, about 400 kB that
 *   the entry chunk mustn't hold: the service worker precaches no chunk over 2 MiB,
 *   and the entry sat 7 kB under that limit before the reader moved here.
 *   The H3 reader is imported on first use for the same reason.
 *
 *   The reader takes trimmed text, so every caller trims the typed input.
 */

import type { readPoint } from "@mailwoman/spatial/point-reading"
import { useEffect, useState } from "react"

/**
 * The reader's own signature, taken from the module without importing it.
 */
export type PointReader = typeof readPoint

let loading: Promise<PointReader> | null = null

/**
 * Imports the reader once and resolves to it.
 * A failed import rejects, and the next call retries.
 */
export function loadPointReader(): Promise<PointReader> {
	loading ??= import("@mailwoman/spatial/point-reading").then(
		(module) => module.readPoint,
		(error: unknown) => {
			loading = null

			throw error
		}
	)

	return loading
}

/**
 * The point reader once it has loaded, and `null` until then.
 *
 * Until it loads, a caller treats the text as an address.
 * A failed import throws during render, so the nearest error boundary shows it
 * and the text never reads as a non-point.
 */
export function usePointReader(): PointReader | null {
	const [reader, setReader] = useState<PointReader | null>(null)

	useEffect(() => {
		let disposed = false

		loadPointReader().then(
			(loaded) => {
				if (!disposed) {
					setReader(() => loaded)
				}
			},
			(error: unknown) => {
				if (!disposed) {
					setReader(() => {
						throw error
					})
				}
			}
		)

		return () => {
			disposed = true
		}
	}, [])

	return reader
}
