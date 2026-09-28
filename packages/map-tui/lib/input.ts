/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The fallback separates a sequence this decoder recognizes (consumed and acted on), a complete
 * but unrecognized sequence (consumed whole so a `q` inside it cannot quit the app), and a
 * chunk that ends mid-sequence (returned as {@link DecodedInput.pending} rather than decoded),
 * emitting quit only for an ESC whose following byte cannot continue a sequence.
 */

/**
 * Enables mouse reporting: button events (1000), drag/button-motion tracking (1002),
 * and SGR extended coordinates (1006) so columns past 223 survive.
 */
export const MOUSE_ENABLE = "\u001B[?1000h\u001B[?1002h\u001B[?1006h"

/**
 * Disables the three mouse-reporting modes {@link MOUSE_ENABLE} turns on.
 */
export const MOUSE_DISABLE = "\u001B[?1006l\u001B[?1002l\u001B[?1000l"

/**
 * A decoded input event; pan and zoom carry direction and magnitude only, since how far
 * a step moves the map is the browser's decision rather than the decoder's.
 */
export type MapTUIInput =
	| { kind: "quit" }
	/**
	 * Ctrl+C. Distinct from `quit` because the process must exit 130, and because raw mode means no sigint is raised.
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

/* oxlint-disable no-control-regex -- ESC (U+001B) is the byte every pattern below exists to match. A decoder of
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
 * Any other CSI sequence, consumed whole and ignored so an unhandled body is not re-scanned as key presses.
 */
const UNKNOWN_CSI_PATTERN = /\u001B\[[\d;<>?]*[\u0020-\u002F]*[\u0040-\u007E]/y

/**
 * Any other SS3 sequence (`ESC O <final>`) — F1–F4 on xterm, and the numeric keypad in application mode.
 */
const UNKNOWN_SS3_PATTERN = /\u001BO[\u0040-\u007E]/y

/**
 * The string-sequence family (OSC, DCS, SOS, PM, APC), each running to a BEL
 * or an ST, sent unasked by a terminal with no key pressed.
 */
const STRING_SEQUENCE_PATTERN = /\u001B[P\]X^_][\s\S]*?(?:\u0007|\u001B\\)/y

/**
 * Every "unrecognized but complete" sequence, in the order they are tried; one shared
 * list keeps a new family from being added here and forgotten in the incomplete test.
 */
const UNRECOGNIZED_PATTERNS = [UNKNOWN_CSI_PATTERN, UNKNOWN_SS3_PATTERN, STRING_SEQUENCE_PATTERN] as const

/**
 * A chunk that stops inside a sequence, each end-anchored pattern requiring the whole
 * remainder of the chunk to be a legal prefix and no more.
 */
const PARTIAL_PATTERNS = [/\u001BO?$/y, /\u001B\[[\d;<>?]*[\u0020-\u002F]*$/y, /\u001B[P\]X^_][^\u0007]*$/y] as const

/* oxlint-enable no-control-regex */

/**
 * Wheel reports set bit 6 of the button field, whose low bit separates up (0) from down (1).
 */
const WHEEL_FLAG = 64

/**
 * Motion reports set bit 5, which under mode 1002 means "moved with a button held" — a drag.
 */
const MOTION_FLAG = 32

const BUTTON_MASK = 3
const LEFT_BUTTON = 0

/**
 * The longest fragment held for the next chunk (64 KB), bounding an unterminated
 * string sequence rather than a real key.
 */
const MAX_PENDING_LENGTH = 65_536

const ARROW_INPUTS: Record<string, MapTUIInput> = {
	A: { kind: "pan", dx: 0, dy: -1 },
	B: { kind: "pan", dx: 0, dy: 1 },
	C: { kind: "pan", dx: 1, dy: 0 },
	D: { kind: "pan", dx: -1, dy: 0 },
}

/**
 * Single-character bindings taken from mapscii: `a`/`z` zoom, `+`/`-` the common pair, `hjkl` the
 * vim pan set, and `y` joining `z` for zoom-out because qwertz places it where qwerty has `z`.
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
 * One decoded chunk: its events, plus whatever trailing bytes could not be decoded yet.
 */
export interface DecodedInput {
	events: MapTUIInput[]
	/**
	 * An unresolved escape fragment from the end of the chunk to prepend to the next,
	 * empty when the chunk ended cleanly.
	 */
	pending: string
}

function consumeUnrecognized(buffer: string, index: number): number | null {
	for (const pattern of UNRECOGNIZED_PATTERNS) {
		pattern.lastIndex = index

		if (pattern.exec(buffer)) return pattern.lastIndex
	}

	return null
}

function isIncompleteSequence(buffer: string, index: number): boolean {
	for (const pattern of PARTIAL_PATTERNS) {
		pattern.lastIndex = index

		if (pattern.exec(buffer)) return true
	}

	return false
}

function mouseInput(button: number, column: number, row: number, final: string): MapTUIInput | null {
	if (button & WHEEL_FLAG) {
		return { kind: "wheel", delta: button & 1 ? -1 : 1, column, row }
	}

	if (final === "m") return { kind: "release" }

	if ((button & BUTTON_MASK) !== LEFT_BUTTON) return null

	return button & MOTION_FLAG ? { kind: "drag", column, row } : { kind: "press", column, row }
}

/**
 * Decodes one raw-mode stdin chunk into input events, dropping unrecognized bytes
 * and returning an unresolved trailing escape fragment as `pending`.
 */
export function decodeInputChunk(chunk: string, pending = ""): DecodedInput {
	const events: MapTUIInput[] = []
	const buffer = pending + chunk
	let index = 0

	while (index < buffer.length) {
		const character = buffer[index]!

		if (character !== ESC) {
			const input = character === CTRL_C ? { kind: "interrupt" as const } : CHARACTER_INPUTS[character]

			if (input) {
				events.push(input)
			}

			index += 1

			continue
		}

		MOUSE_SGR_PATTERN.lastIndex = index
		const mouse = MOUSE_SGR_PATTERN.exec(buffer)

		if (mouse) {
			const input = mouseInput(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4]!)

			if (input) {
				events.push(input)
			}

			index = MOUSE_SGR_PATTERN.lastIndex

			continue
		}

		ARROW_PATTERN.lastIndex = index
		const arrow = ARROW_PATTERN.exec(buffer)

		if (arrow) {
			events.push(ARROW_INPUTS[arrow[1]!]!)
			index = ARROW_PATTERN.lastIndex

			continue
		}

		const consumed = consumeUnrecognized(buffer, index)

		if (consumed !== null) {
			index = consumed

			continue
		}

		// The buffer stops inside a sequence — hand the fragment back instead of guessing at it.
		if (isIncompleteSequence(buffer, index)) {
			const fragment = buffer.slice(index)

			// An unterminated string sequence would otherwise grow the held fragment for the life of the
			// process, and dropping is the safe failure because flushing the body back would read it as keys.
			return { events, pending: fragment.length > MAX_PENDING_LENGTH ? "" : fragment }
		}

		// An ESC whose next byte cannot continue a sequence: the Esc KEY.
		events.push({ kind: "quit" })
		index += 1
	}

	return { events, pending: "" }
}
