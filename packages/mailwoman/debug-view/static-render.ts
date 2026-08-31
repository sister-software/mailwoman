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

import { Duplex } from "@mailwoman/core/fs/streams"
import { render } from "ink"
import type React from "react"

/**
 * A `WriteStream` stand-in that keeps every frame Ink writes.
 *
 * The assertion at the call site goes through `unknown`, and that is correct here rather than a checker bypass worth
 * removing: Ink types `stdout` as `NodeJS.WriteStream` — a `tty.WriteStream` over a socket, carrying `fd`, `rows`,
 * `cursorTo`, `getColorDepth` and the rest of `net.Socket` — while reading only `columns`, `isTTY` and `write`. No
 * double can be assignable in either direction, so no single assertion is legal. What the shape below buys is that
 * everything OTHER than the gap is still checked: the frames live outside the class and `write` keeps the base
 * signature, so the only unchecked claim is the one the comment names.
 */
class CaptureStream extends Duplex {
	columns: number
	// `boolean`, not the literal `false`: `WriteStream` declares `isTTY: true`, and a literal type on this side leaves
	// the two mutually unassignable, which is what forces an assertion through `unknown`. The VALUE stays false —
	// Ink resolves its interactive mode from it, and a static render wants the non-interactive single frame.
	isTTY = false

	readonly #frames: string[]

	constructor(columns: number, frames: string[]) {
		super()
		this.columns = columns
		this.#frames = frames
	}

	// The base signature, not a narrowed one: `write(chunk: string)` is a different member from `WriteStream`'s
	// overloaded `write`, and one mismatched member is enough to make the two mutually unassignable.
	override write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
		void encoding
		void callback
		this.#frames.push(String(chunk))

		return true
	}
}

export async function renderInkToString(tree: React.ReactElement, columns: number): Promise<string> {
	const frames: string[] = []
	const stdout = new CaptureStream(columns, frames)

	const instance = render(tree, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		patchConsole: false,
		exitOnCtrlC: false,
	})

	instance.unmount()

	return frames.at(-1) ?? ""
}
