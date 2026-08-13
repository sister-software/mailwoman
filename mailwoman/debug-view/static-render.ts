/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render an Ink tree to a plain string, once — no TTY, no timers. Doubles as the `DebugFrame`
 *   component-test harness and as the static (non-interactive) capture path a later task's command
 *   drives.
 *
 *   Measured on Ink 7.1.1 (DebugFrame.test.tsx, 2026-08-13): the non-TTY mount's final `write()` lands
 *   on the capture stream synchronously, before `render()` returns — `frames.at(-1)` already holds the
 *   finished frame by the time `unmount()` is called. No `await setImmediate` wait was needed to make
 *   the tests pass. If a future Ink version defers that write past mount (a caller sees an empty or
 *   partial capture), insert `await new Promise((r) => setImmediate(r))` before `instance.unmount()` —
 *   that is the one sanctioned adjustment (see the Task 11 brief).
 */

import { EventEmitter } from "node:events"

import { render } from "ink"
import type React from "react"

class CaptureStream extends EventEmitter {
	readonly frames: string[] = []
	columns: number
	readonly isTTY = false

	constructor(columns: number) {
		super()
		this.columns = columns
	}

	write(chunk: string): boolean {
		this.frames.push(chunk)

		return true
	}
}

export async function renderInkToString(tree: React.ReactElement, columns: number): Promise<string> {
	const stdout = new CaptureStream(columns)

	const instance = render(tree, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		patchConsole: false,
		exitOnCtrlC: false,
	})

	instance.unmount()

	return stdout.frames.at(-1) ?? ""
}
