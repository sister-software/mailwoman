/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Terminal input decoding for the interactive map browser.
 *
 * `decodeInputChunk` turns a raw-mode stdin chunk into zero or more {@link MapTUIInput} events. It stays pure — the
 * caller owns the only state there is, the unresolved trailing fragment the function hands back — so one chunk in gives
 * the same events out every time.
 *
 * THE FALLBACK IS THE DANGEROUS PART. An ESC this decoder had no rule for used to mean "the Esc key", i.e. QUIT, which
 * made every unrecognized escape sequence a quit: F1 (`ESC O P`), an OSC reply the terminal sends unasked (`ESC ] 11 ;
 * rgb:… BEL`), and — worst, because it needs no exotic key at all — a mouse report split across two stdin reads, whose
 * first half ends inside the sequence. So the fallback now separates three cases:
 *
 * - A sequence this decoder recognizes is consumed and acted on (arrows, SGR mouse).
 * - A sequence it does NOT recognize is consumed WHOLE and ignored: CSI (`ESC [ … final`), SS3 (`ESC O final`), and the
 *   string family (OSC/DCS/SOS/PM/APC, terminated by BEL or ST). Re-scanning their bodies as characters is how a `q`
 *   inside a cursor-position report quit the app.
 * - A chunk that ENDS mid-sequence — including a lone trailing ESC, which is byte-for-byte the start of one — is not
 *   decoded at all: it comes back as {@link DecodedInput.pending} for the caller to prepend to the next chunk. Quit is
 *   emitted only for an ESC that is neither, i.e. one whose following byte cannot continue a sequence.
 *
 * Holding costs a lone Esc keypress its effect until the next byte arrives. That is the right side of the trade for a
 * browser whose advertised quit keys are `q` and Ctrl+C: the alternative is a drag ending the session because the
 * kernel split a read.
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
 * Any other CSI sequence, consumed whole and ignored. Without this, an unhandled sequence's body would be re-scanned as
 * individual key presses, and a stray `q` inside one would quit the app.
 */
const UNKNOWN_CSI_PATTERN = /\u001B\[[\d;<>?]*[\u0020-\u002F]*[\u0040-\u007E]/y

/**
 * Any other SS3 sequence (`ESC O <final>`) — F1–F4 on xterm, and the numeric keypad in application mode. Two bytes
 * shorter than a CSI, and until this pattern existed the likeliest key on a keyboard to quit the browser by accident.
 */
const UNKNOWN_SS3_PATTERN = /\u001BO[\u0040-\u007E]/y

/**
 * The string-sequence family: OSC (`ESC ]`), DCS (`ESC P`), SOS (`ESC X`), PM (`ESC ^`), APC (`ESC _`), each running to
 * a BEL or an ST (`ESC \`). A terminal sends these UNASKED — an OSC colour or clipboard reply lands on stdin with no
 * key pressed — so consuming them is not a nicety.
 */
const STRING_SEQUENCE_PATTERN = /\u001B[P\]X^_][\s\S]*?(?:\u0007|\u001B\\)/y

/**
 * Every "unrecognized but complete" sequence, in the order they are tried. Sharing one list is what keeps a new
 * sequence family from being added to the consumer and forgotten in the incomplete test below.
 */
const UNRECOGNIZED_PATTERNS = [UNKNOWN_CSI_PATTERN, UNKNOWN_SS3_PATTERN, STRING_SEQUENCE_PATTERN] as const

/**
 * A chunk that STOPS inside a sequence. The end-anchors are what make these "incomplete" rather than "unrecognized":
 * each requires the WHOLE remainder of the chunk to be a legal prefix and nothing more. The first covers both a lone
 * trailing ESC and an `ESC O` still waiting for its final byte.
 */
const PARTIAL_PATTERNS = [/\u001BO?$/y, /\u001B\[[\d;<>?]*[\u0020-\u002F]*$/y, /\u001B[P\]X^_][^\u0007]*$/y] as const

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

/**
 * The longest fragment worth holding for the next chunk (64 KB). See the drop site: this bounds an unterminated string
 * sequence, not a real key.
 */
const MAX_PENDING_LENGTH = 65_536

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
 * One decoded chunk: its events, plus whatever trailing bytes could not be decoded YET.
 */
export interface DecodedInput {
	events: MapTUIInput[]
	/**
	 * An unresolved escape fragment from the end of the chunk — prepend it to the next one. Empty when the chunk ended
	 * cleanly, which is the overwhelmingly common case.
	 */
	pending: string
}

/**
 * The length of the unrecognized-but-complete sequence at `index`, or null when there isn't one.
 */
function consumeUnrecognized(buffer: string, index: number): number | null {
	for (const pattern of UNRECOGNIZED_PATTERNS) {
		pattern.lastIndex = index

		if (pattern.exec(buffer)) return pattern.lastIndex
	}

	return null
}

/**
 * True when everything from `index` to the end of the chunk is a legal PREFIX of a sequence — i.e. the terminal is
 * mid-sequence and the rest is in the next read.
 */
function isIncompleteSequence(buffer: string, index: number): boolean {
	for (const pattern of PARTIAL_PATTERNS) {
		pattern.lastIndex = index

		if (pattern.exec(buffer)) return true
	}

	return false
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
 * Decodes one raw-mode stdin chunk into input events. Unrecognized bytes are dropped; an unresolved trailing escape
 * fragment is returned rather than decoded, and the caller passes it back as `pending` with the next chunk.
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

			// …unless it has stopped being plausible. An unterminated string sequence would otherwise grow the held
			// fragment for the life of the process. Dropping is the safe failure: it emits nothing, where flushing
			// the fragment back through the decoder would read its body as keys, which is the bug this all exists
			// for. The cap is generous because an OSC 52 clipboard reply is legitimately large.
			return { events, pending: fragment.length > MAX_PENDING_LENGTH ? "" : fragment }
		}

		// An ESC whose next byte cannot continue a sequence: the Esc KEY.
		events.push({ kind: "quit" })
		index += 1
	}

	return { events, pending: "" }
}
