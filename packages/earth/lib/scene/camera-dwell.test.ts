// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { CameraDwell, type CameraSource, type DwellState } from "#scene/camera-dwell"

/**
 * A map stand-in that emits move events on demand.
 */
class FakeCamera implements CameraSource {
	zoom: number
	pitch: number
	#listeners = new Map<string, Set<() => void>>()

	constructor(zoom: number, pitch: number) {
		this.zoom = zoom
		this.pitch = pitch
	}

	on(type: string, listener: () => void): void {
		const set = this.#listeners.get(type) ?? new Set()

		set.add(listener)
		this.#listeners.set(type, set)
	}

	off(type: string, listener: () => void): void {
		this.#listeners.get(type)?.delete(listener)
	}

	getZoom(): number {
		return this.zoom
	}

	getPitch(): number {
		return this.pitch
	}

	listenerCount(): number {
		return [...this.#listeners.values()].reduce((sum, set) => sum + set.size, 0)
	}

	emit(type: "movestart" | "moveend"): void {
		for (const listener of this.#listeners.get(type) ?? []) {
			listener()
		}
	}

	/**
	 * A move that ends at `zoom` and `pitch`.
	 */
	moveTo(zoom: number, pitch: number): void {
		this.emit("movestart")
		this.zoom = zoom
		this.pitch = pitch
		this.emit("moveend")
	}
}

const CRITERIA = { minZoom: 15, minPitch: 30, dwellMs: 600 }

function watch(camera: FakeCamera, ready = true) {
	const changes: DwellState[] = []
	const dwell = new CameraDwell(camera, CRITERIA, (state) => changes.push(state))

	dwell.start()
	dwell.setReady(ready)

	return { dwell, changes }
}

describe("CameraDwell", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("arms after the camera rests for the dwell on a qualifying view", () => {
		const { dwell } = watch(new FakeCamera(16, 45))

		vi.advanceTimersByTime(599)
		expect(dwell.state.armed).toBe(false)

		vi.advanceTimersByTime(1)
		expect(dwell.state).toEqual({ armed: true, everArmed: true })
	})

	test("stays disarmed below the minimum pitch or zoom", () => {
		const camera = new FakeCamera(16, 10)
		const { dwell } = watch(camera)

		vi.advanceTimersByTime(1000)
		expect(dwell.state.armed).toBe(false)

		camera.moveTo(14, 60)
		vi.advanceTimersByTime(1000)
		expect(dwell.state.armed).toBe(false)
	})

	test("disarms on movestart and keeps everArmed", () => {
		const camera = new FakeCamera(16, 45)
		const { dwell } = watch(camera)

		vi.advanceTimersByTime(600)
		camera.emit("movestart")

		expect(dwell.state).toEqual({ armed: false, everArmed: true })
	})

	test("restarts the dwell when a move starts before it finishes", () => {
		const camera = new FakeCamera(16, 45)
		const { dwell } = watch(camera)

		vi.advanceTimersByTime(400)
		camera.moveTo(16.5, 50)
		vi.advanceTimersByTime(400)
		expect(dwell.state.armed).toBe(false)

		vi.advanceTimersByTime(200)
		expect(dwell.state.armed).toBe(true)
	})

	test("waits for the runtime even after the camera rests", () => {
		const { dwell } = watch(new FakeCamera(16, 45), false)

		vi.advanceTimersByTime(1000)
		expect(dwell.state.armed).toBe(false)

		dwell.setReady(true)
		expect(dwell.state.armed).toBe(true)
	})

	test("publishes only changes", () => {
		const camera = new FakeCamera(16, 45)
		const { changes } = watch(camera)

		vi.advanceTimersByTime(600)
		camera.emit("moveend")
		vi.advanceTimersByTime(600)

		expect(changes).toEqual([{ armed: true, everArmed: true }])
	})

	test("stop removes its listeners and cancels a pending dwell", () => {
		const camera = new FakeCamera(16, 45)
		const { dwell } = watch(camera)

		dwell.stop()
		vi.advanceTimersByTime(1000)

		expect(camera.listenerCount()).toBe(0)
		expect(dwell.state.armed).toBe(false)
	})
})
