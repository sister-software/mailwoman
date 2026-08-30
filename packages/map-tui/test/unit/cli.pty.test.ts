/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * End-to-end smoke of the `map-tui` bin, driven through a real pty.
 *
 * A pty is not a nicety here: the app only takes over the screen when stdin can be put in raw mode, so a piped-stdio
 * child would render nothing and exit on EOF. `script` supplies one — `-e` returns the child's exit code, and `stty`
 * inside the command sets a window size, since a pty created without a controlling terminal reports 0x0.
 *
 * The bin is run from SOURCE rather than `out/cli.js` so the suite carries no dependency on a prior `yarn compile`;
 * Node runs the `.ts` entry directly, which is the same thing the repo's other source-first tooling relies on.
 */

import { isExecutableSync } from "@mailwoman/core/fs/readers-sync"
import { spawn } from "@mailwoman/platform/child_process"
import { fileURLToPath } from "@mailwoman/platform/url"
import { describe, expect, it } from "vitest"

const ESC = "\u001B"
const ALT_SCREEN_ENTER = `${ESC}[?1049h`
const ALT_SCREEN_EXIT = `${ESC}[?1049l`
const CURSOR_HIDE = `${ESC}[?25l`
const CURSOR_SHOW = `${ESC}[?25h`
const MOUSE_SGR_ENABLE = `${ESC}[?1006h`
const MOUSE_SGR_DISABLE = `${ESC}[?1006l`

const BRAILLE_PATTERN = /[⠀-⣿]/u

/**
 * The status bar's coordinate/zoom field, which doubles as the ready signal — its first appearance means a frame has
 * been rendered and raw mode is on, so keystrokes will land.
 */
const STATUS_PATTERN = /-?\d+\.\d{4},-?\d+\.\d{4} z\d+/g

const CLI = fileURLToPath(new URL("../../cli.ts", import.meta.url))
const FIXTURE = fileURLToPath(new URL("../fixtures/portland.pmtiles", import.meta.url))

const PTY_COLUMNS = 100
const PTY_ROWS = 30

const READY_TIMEOUT_MS = 20_000
const KEYSTROKE_GAP_MS = 250
const TEST_TIMEOUT_MS = 40_000

/**
 * `script` is util-linux's, and this test's `-e` / `-c` spelling is too. macOS ships a BSD `script` with different
 * flags; rather than maintain two invocations for a smoke test, the suite runs where CI runs.
 */
function hasLinuxScript(): boolean {
	if (process.platform !== "linux") return false

	return isExecutableSync("/usr/bin/script")
}

interface PTYRun {
	output: string
	code: number | null
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Runs the bin against the fixture and feeds it `keys`, one keystroke at a time, once the first frame is on screen.
 */
async function driveMap(keys: string[]): Promise<PTYRun> {
	const command = [
		`stty cols ${PTY_COLUMNS} rows ${PTY_ROWS}`,
		`node '${CLI}' --tiles '${FIXTURE}' --lat 45.5034 --lon=-122.6023 --zoom 12`,
	].join("; ")

	const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] })

	let output = ""

	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8")
	})

	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8")
	})

	const exited = new Promise<number | null>((resolve) => {
		child.on("exit", (code) => resolve(code))
	})

	const deadline = Date.now() + READY_TIMEOUT_MS

	while (!output.includes("q quit") && Date.now() < deadline) {
		await delay(25)
	}

	for (const key of keys) {
		child.stdin.write(key)
		await delay(KEYSTROKE_GAP_MS)
	}

	const code = await exited

	return { output, code }
}

/**
 * Every distinct `lat,lon zN` the status bar showed, in order of first appearance.
 */
function statusSamples(output: string): string[] {
	return [...new Set(output.match(STATUS_PATTERN))]
}

/**
 * The center a status sample reports.
 */
function centerOf(sample: string): { lat: number; lon: number } {
	const [lat, lon] = sample.split(" ")[0]!.split(",")

	return { lat: Number(lat), lon: Number(lon) }
}

/**
 * An SGR mouse report, in the form mode 1006 sends: 1-based coordinates, `M` to press or move, `m` to release.
 */
function mouseReport(button: number, column: number, row: number, final: "M" | "m"): string {
	return `${ESC}[<${button};${column};${row}${final}`
}

describe.skipIf(!hasLinuxScript())("map-tui bin (pty)", () => {
	it(
		"draws a braille map, responds to keys, and hands the terminal back on quit",
		async () => {
			const { output, code } = await driveMap([`${ESC}[C`, `${ESC}[B`, "+", "q"])

			expect(output).toContain(ALT_SCREEN_ENTER)
			expect(output).toContain(CURSOR_HIDE)
			expect(output).toContain(MOUSE_SGR_ENABLE)
			expect(output).toMatch(BRAILLE_PATTERN)

			const samples = statusSamples(output)

			expect(samples[0]).toBe("45.5034,-122.6023 z12")
			expect(output).toContain("←↑↓→ pan  +/- zoom  q quit")

			// Right, down, zoom in: three distinct viewports past the opening one.
			expect(samples.length).toBeGreaterThanOrEqual(4)
			expect(samples.some((sample) => sample.endsWith("z13"))).toBe(true)

			// The terminal must be exactly as it was found — anything less leaves an unusable shell.
			expect(output).toContain(MOUSE_SGR_DISABLE)
			expect(output).toContain(CURSOR_SHOW)
			expect(output).toContain(ALT_SCREEN_EXIT)
			expect(code).toBe(0)
		},
		TEST_TIMEOUT_MS
	)

	it(
		"pans on a mouse drag and zooms toward the wheel's pointer",
		async () => {
			const LEFT_PRESS = 0
			const LEFT_MOTION = 32
			const WHEEL_UP = 64

			const { output, code } = await driveMap([
				mouseReport(LEFT_PRESS, 50, 15, "M"),
				mouseReport(LEFT_MOTION, 40, 10, "M"),
				mouseReport(LEFT_PRESS, 40, 10, "m"),
				mouseReport(WHEEL_UP, 20, 8, "M"),
				"q",
			])

			const samples = statusSamples(output)
			const opened = centerOf(samples[0]!)
			const dragged = centerOf(samples[1]!)

			// Dragging the pointer up and to the left drags the map with it, so the viewport moves south-east.
			expect(dragged.lon).toBeGreaterThan(opened.lon)
			expect(dragged.lat).toBeLessThan(opened.lat)

			expect(samples.at(-1)).toContain("z13")
			expect(code).toBe(0)
		},
		TEST_TIMEOUT_MS
	)

	it(
		"restores the terminal and exits 130 on Ctrl+C",
		async () => {
			// Raw mode means no SIGINT is raised: the app sees the byte and owns the exit code itself.
			const { output, code } = await driveMap(["\u0003"])

			expect(code).toBe(130)
			expect(output).toContain(MOUSE_SGR_DISABLE)
			expect(output).toContain(CURSOR_SHOW)
			expect(output).toContain(ALT_SCREEN_EXIT)
		},
		TEST_TIMEOUT_MS
	)
})
