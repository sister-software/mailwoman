/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Terminal input decoding for the interactive map browser.
 *
 * `decodeInputChunk` turns a raw-mode stdin chunk into zero or more {@link MapTUIInput} events. It is pure and
 * stateless: one chunk in, events out. Escape sequences arrive whole in practice (a terminal writes a key's bytes in
 * one go), so a lone `0x1B` byte is read as the Esc KEY rather than a truncated sequence — the same bet every raw TUI
 * makes, and the reason an unrecognized CSI is consumed to its final byte instead of being re-scanned as letters.
 *
 * Mouse reports are SGR-encoded (DEC private mode 1006), which is what {@link MOUSE_ENABLE} asks for. Their coordinates
 * are 1-based on the wire and 0-based in every event here — the off-by-one lives at this boundary and nowhere else.
 */

/**
 * Enables mouse reporting: button events (1000), drag/button-motion tracking (1002), and SGR extended coordinates
 * (1006) so columns past 223 survive.
 */
export const MOUSE_ENABLE = "\u001B[?1000h\u001B[?1002h\u001B[?1006h"

/**
 * Disables mouse reporting, in the reverse order it was enabled.
 */
export const MOUSE_DISABLE = "\u001B[?1006l\u001B[?1002l\u001B[?1000l"

/**
 * A decoded input event. Pan and zoom carry direction and magnitude only — how far a step moves the map is the
 * browser's decision, not the decoder's.
 */
export type MapTUIInput =
	| { kind: "quit" }
	/**
	 * Ctrl+C. Distinct from `quit` because the process must exit 130, and because raw mode means no SIGINT is raised.
	 */
	| { kind: "interrupt" }
	| { kind: "pan"; dx: number; dy: number }
	| { kind: "zoom"; delta: number }
	| { kind: "wheel"; delta: number; column: number; row: number }
	| { kind: "press"; column: number; row: number }
	| { kind: "drag"; column: number; row: number }
	| { kind: "release" }

const ESC = "\u001B"
const CTRL_C = "\u0003"

/* oxlint-disable no-control-regex -- ESC (U+001B) is the byte these three patterns exist to match. A decoder of
   terminal escape sequences cannot avoid the control character the sequences are made of. */

/**
 * SGR mouse report: `ESC [ < button ; column ; row (M|m)`, where `M` is a press/motion and `m` a release.
 */
const MOUSE_SGR_PATTERN = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/y

/**
 * Cursor keys, in both normal (`ESC [ A`) and application (`ESC O A`) modes — a terminal may be left in either.
 */
const ARROW_PATTERN = /\u001B(?:\[|O)([ABCD])/y

/**
 * Any other CSI sequence, consumed whole and ignored. Without this, an unhandled sequence's body would be re-scanned as
 * individual key presses, and a stray `q` inside one would quit the app.
 */
const UNKNOWN_CSI_PATTERN = /\u001B\[[\d;<>?]*[\u0020-\u002F]*[\u0040-\u007E]/y

/* oxlint-enable no-control-regex */

/**
 * Wheel reports set bit 6 of the button field; the low bit then separates up (0) from down (1).
 */
const WHEEL_FLAG = 64

/**
 * Motion reports set bit 5. With mode 1002 that means "moved with a button held" — a drag.
 */
const MOTION_FLAG = 32

const BUTTON_MASK = 3
const LEFT_BUTTON = 0

const ARROW_INPUTS: Record<string, MapTUIInput> = {
	A: { kind: "pan", dx: 0, dy: -1 },
	B: { kind: "pan", dx: 0, dy: 1 },
	C: { kind: "pan", dx: 1, dy: 0 },
	D: { kind: "pan", dx: -1, dy: 0 },
}

/**
 * Single-character bindings. `a`/`z` are mapscii's zoom keys, `+`/`-` the ones every other map uses, and `hjkl` the vim
 * pan set mapscii also accepts. `y` joins `z` for zoom-out because on a QWERTZ keyboard it sits where `z` does on
 * QWERTY — mapscii binds both for the same reason.
 */
const CHARACTER_INPUTS: Record<string, MapTUIInput> = {
	q: { kind: "quit" },
	Q: { kind: "quit" },
	"+": { kind: "zoom", delta: 1 },
	"=": { kind: "zoom", delta: 1 },
	a: { kind: "zoom", delta: 1 },
	"-": { kind: "zoom", delta: -1 },
	_: { kind: "zoom", delta: -1 },
	z: { kind: "zoom", delta: -1 },
	y: { kind: "zoom", delta: -1 },
	h: { kind: "pan", dx: -1, dy: 0 },
	j: { kind: "pan", dx: 0, dy: 1 },
	k: { kind: "pan", dx: 0, dy: -1 },
	l: { kind: "pan", dx: 1, dy: 0 },
}

/**
 * Builds the event for one SGR mouse report.
 */
function mouseInput(button: number, column: number, row: number, final: string): MapTUIInput | null {
	if (button & WHEEL_FLAG) {
		return { kind: "wheel", delta: button & 1 ? -1 : 1, column, row }
	}

	if (final === "m") return { kind: "release" }

	if ((button & BUTTON_MASK) !== LEFT_BUTTON) return null

	return button & MOTION_FLAG ? { kind: "drag", column, row } : { kind: "press", column, row }
}

/**
 * Decodes one raw-mode stdin chunk into input events. Unrecognized bytes are dropped.
 */
export function decodeInputChunk(chunk: string): MapTUIInput[] {
	const events: MapTUIInput[] = []
	let index = 0

	while (index < chunk.length) {
		const character = chunk[index]!

		if (character !== ESC) {
			const input = character === CTRL_C ? { kind: "interrupt" as const } : CHARACTER_INPUTS[character]

			if (input) {
				events.push(input)
			}

			index += 1

			continue
		}

		MOUSE_SGR_PATTERN.lastIndex = index
		const mouse = MOUSE_SGR_PATTERN.exec(chunk)

		if (mouse) {
			const input = mouseInput(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4]!)

			if (input) {
				events.push(input)
			}

			index = MOUSE_SGR_PATTERN.lastIndex

			continue
		}

		ARROW_PATTERN.lastIndex = index
		const arrow = ARROW_PATTERN.exec(chunk)

		if (arrow) {
			events.push(ARROW_INPUTS[arrow[1]!]!)
			index = ARROW_PATTERN.lastIndex

			continue
		}

		UNKNOWN_CSI_PATTERN.lastIndex = index
		const unknown = UNKNOWN_CSI_PATTERN.exec(chunk)

		if (unknown) {
			index = UNKNOWN_CSI_PATTERN.lastIndex

			continue
		}

		// A bare Esc, or an escape sequence this decoder has no rule for: treat as the Esc key.
		events.push({ kind: "quit" })
		index += 1
	}

	return events
}
