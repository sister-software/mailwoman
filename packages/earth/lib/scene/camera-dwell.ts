// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Whether the camera has settled on a view that a 3D layer should load for.
 *
 *   A 3D layer that fetches on every frame of a fly-over spends memory
 *   and bandwidth on views the reader passes through.
 *   The layers here wait until the camera stops at a zoom and pitch where their models read as 3D, and
 *   until the geocoder runtime has loaded, so the 3D downloads don't compete with the model download.
 */

import { useEffect, useRef, useState } from "react"

/**
 * The map events and camera readings the dwell watches, a subset of MapLibre's `Map`.
 */
export interface CameraSource {
	on(type: "movestart" | "moveend", listener: () => void): unknown
	off(type: "movestart" | "moveend", listener: () => void): unknown
	getZoom(): number
	getPitch(): number
}

/**
 * The camera a layer waits for.
 */
export interface DwellCriteria {
	minZoom: number
	/**
	 * The lowest pitch in degrees.
	 */
	minPitch: number
	/**
	 * How long the camera must stay still, in milliseconds, after its last move ends.
	 */
	dwellMs: number
}

/**
 * The pitch, in degrees, from which buildings read as 3D rather than as roofs seen from above.
 */
export const DWELL_MIN_PITCH = 30

/**
 * How long the camera must rest before a 3D layer fetches.
 *
 * Long enough to skip the pauses within a pan gesture, short enough that the reader doesn't wait.
 */
export const DWELL_MS = 600

/**
 * The dwell's state: `armed` while the camera rests on a qualifying view and the
 * runtime is ready, `everArmed` once it has been armed on this mount.
 */
export interface DwellState {
	armed: boolean
	everArmed: boolean
}

/**
 * The timer functions the dwell schedules with, replaceable in tests.
 */
export interface DwellTimers {
	set(callback: () => void, ms: number): unknown
	clear(handle: unknown): void
}

const GLOBAL_TIMERS: DwellTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Tracks one camera against one {@link DwellCriteria}.
 *
 * A move disarms it at once.
 * The end of a move on a qualifying view starts the dwell timer, and the timer arms it
 * unless another move starts first.
 */
export class CameraDwell {
	#camera: CameraSource
	#criteria: DwellCriteria
	#onChange: (state: DwellState) => void
	#timers: DwellTimers
	#timer: unknown = null
	#ready = false
	#resting = false
	#state: DwellState = { armed: false, everArmed: false }

	constructor(
		camera: CameraSource,
		criteria: DwellCriteria,
		onChange: (state: DwellState) => void,
		timers: DwellTimers = GLOBAL_TIMERS
	) {
		this.#camera = camera
		this.#criteria = criteria
		this.#onChange = onChange
		this.#timers = timers
	}

	get state(): DwellState {
		return this.#state
	}

	/**
	 * Starts watching, treating the current view as the end of a move.
	 */
	start(): void {
		this.#camera.on("movestart", this.#moveStart)
		this.#camera.on("moveend", this.#moveEnd)
		this.#moveEnd()
	}

	stop(): void {
		this.#camera.off("movestart", this.#moveStart)
		this.#camera.off("moveend", this.#moveEnd)
		this.#cancel()
	}

	/**
	 * Sets whether the runtime the layer waits for has loaded.
	 */
	setReady(ready: boolean): void {
		this.#ready = ready
		this.#publish()
	}

	#moveStart = (): void => {
		this.#cancel()
		this.#resting = false
		this.#publish()
	}

	#moveEnd = (): void => {
		this.#cancel()

		const { minZoom, minPitch, dwellMs } = this.#criteria

		if (this.#camera.getZoom() < minZoom || this.#camera.getPitch() < minPitch) {
			this.#resting = false
			this.#publish()

			return
		}

		this.#timer = this.#timers.set(() => {
			this.#timer = null
			this.#resting = true
			this.#publish()
		}, dwellMs)
	}

	#cancel(): void {
		if (this.#timer != null) {
			this.#timers.clear(this.#timer)
			this.#timer = null
		}
	}

	#publish(): void {
		const armed = this.#ready && this.#resting
		const everArmed = this.#state.everArmed || armed

		if (armed === this.#state.armed && everArmed === this.#state.everArmed) return

		this.#state = { armed, everArmed }
		this.#onChange(this.#state)
	}
}

const IDLE: DwellState = { armed: false, everArmed: false }

/**
 * Whether `camera` rests on a view meeting `criteria` while `ready` holds.
 *
 * `criteria` is read when the camera changes, so pass a module constant.
 */
export function useCameraDwell(camera: CameraSource | null, criteria: DwellCriteria, ready: boolean): DwellState {
	const [state, setState] = useState<DwellState>(IDLE)
	const dwellRef = useRef<CameraDwell | null>(null)
	const readyRef = useRef(ready)

	useEffect(() => {
		if (!camera) return

		const dwell = new CameraDwell(camera, criteria, setState)

		dwellRef.current = dwell
		dwell.start()
		dwell.setReady(readyRef.current)

		return () => {
			dwell.stop()
			dwellRef.current = null
			setState(IDLE)
		}
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- The criteria are module constants.
	}, [camera])

	useEffect(() => {
		readyRef.current = ready
		dwellRef.current?.setReady(ready)
	}, [ready])

	return state
}
