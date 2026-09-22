/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render an Ink tree to a plain string once, without TTY or timers.
 *   Used for `DebugFrame` tests and static, non-interactive capture.
 *
 *   On Ink 7.1.1, the final non-TTY `write()` happens before `render()` returns.
 *   If a future Ink version delays that write, add
 *   `await new Promise((r) => setImmediate(r))` before `instance.unmount()`.
 */

import { Duplex } from "@mailwoman/core/fs/streams"
import { render } from "ink"
import type React from "react"

/**
 * `WriteStream` test double that records every frame Ink writes.
 *
 * The `stdout` cast goes through `unknown` because Ink expects `NodeJS.WriteStream`
 * (socket-backed), but only uses `columns`, `isTTY`, and `write` here.
 * The cast isolates that known type gap.
 */
class CaptureStream extends Duplex {
	columns: number
	// Keep this typed as `boolean` (not literal `false`) for assignability.
	// Value stays false so Ink uses non-interactive rendering.
	isTTY = false

	readonly #frames: string[]

	constructor(columns: number, frames: string[]) {
		super()
		this.columns = columns
		this.#frames = frames
	}

	// Keep the base signature to stay compatible with `WriteStream` overloads.
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

	// Unmount writes an empty trailing frame.
	// The last frame carrying content is the one to return.
	return frames.findLast((frame) => frame.length) ?? ""
}
