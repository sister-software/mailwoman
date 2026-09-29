/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the debug view's input field through a real PTY. It checks the bytes a terminal sends for Alt+Backspace
 *   and the values Ink's keypress parser assigns to them. A component test sees only the input passed to `useInput`.
 *
 *   The PTY probe checks two terminal sequences:
 *
 *   - `\x17` (ctrl+W — the tty's `werase`, and what iTerm2 sends for ⌥⌫ by default) arrives as
 *       `input: "w", key.ctrl: true`, because Ink resolves ctrl+letter to the letter. `ink-text-input` guards only
 *       ctrl+C, so its insert branch typed the `w`: `hello world` → `hello worldw`. That is the reported
 *       "alt+backspace inserts a w".
 *   - `\x1b\x7f` (meta+backspace) arrives as `input: "", key.backspace + key.meta`, and was treated as a plain
 *       backspace — one character deleted rather than one word.
 *
 *   Both sequences must delete the word before the cursor. The field must also remove the resolved letter.
 *
 *   The test uses util-linux `script` with its `-e` and `-c` options.
 *   It skips when another `script` executable appears first on `PATH`, like `map-tui/cli.pty.test.ts`.
 */

import { isExecutable } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { spawnProcess } from "@mailwoman/core/process"
import { describe, expect, it } from "vitest"

const ESC = "\u001B"

/**
 * Meta+backspace as a terminal sends it (ESC then DEL).
 */
const META_BACKSPACE = `${ESC}\u007F`

/**
 * Ctrl+W — the tty's word-erase byte.
 */
const CTRL_W = "\u0017"

const PROBE = resolvePackagePath("mailwoman", "lib", "debug-view", "test", "input-probe.ts")

const PTY_COLUMNS = 100
const PTY_ROWS = 30

const READY_TIMEOUT_MS = 20_000
const KEYSTROKE_GAP_MS = 250
const TEST_TIMEOUT_MS = 60_000

async function hasLinuxScript(): Promise<boolean> {
	if (process.platform !== "linux") return false

	return await isExecutable("/usr/bin/script")
}

const HAS_LINUX_SCRIPT = await hasLinuxScript()

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Run the probe under a pty and feed it `keys`, one write at a time, once the first frame is on screen.
 */
async function driveInput(keys: string[]): Promise<string> {
	const command = [`stty cols ${PTY_COLUMNS} rows ${PTY_ROWS}`, `node '${PROBE}'`].join("; ")
	const child = spawnProcess("script", ["-q", "-e", "-c", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] })

	let output = ""

	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8")
	})

	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8")
	})

	const exited = new Promise<void>((resolve) => {
		child.on("exit", () => resolve())
	})

	const deadline = Date.now() + READY_TIMEOUT_MS

	while (!output.includes("READY") && Date.now() < deadline) {
		await delay(25)
	}

	for (const key of keys) {
		child.stdin.write(key)
		await delay(KEYSTROKE_GAP_MS)
	}

	// Escape is the probe's quit.
	// The kill is the belt-and-braces for a frame that never arrived.
	child.stdin.write(ESC)
	await delay(KEYSTROKE_GAP_MS)
	child.kill("SIGKILL")
	await exited

	return output
}

/**
 * Every `value=[…]` the probe rendered, in stream order — the field's edit history.
 *
 * Keeps duplicate values because both word deletes here produce `hello `.
 * A `Set` would hide the second value and prevent the test from checking the last frame.
 */
function valueSamples(output: string): string[] {
	// oxlint-disable-next-line no-control-regex -- stripping SGR from a pty capture is matching a control character
	return output.replaceAll(/\u001B\[[\d;?]*[a-zA-Z]/gu, "").match(/VALUE=\[[^\]]*\]/gu) ?? []
}

describe.skipIf(!HAS_LINUX_SCRIPT)("debug-view input field (pty)", () => {
	it(
		"deletes the word before the cursor on meta+backspace and on ctrl+W, inserting nothing",
		async () => {
			const output = await driveInput(["hello world", META_BACKSPACE, "there", CTRL_W])
			const samples = valueSamples(output)

			expect(samples).toContain("VALUE=[hello world]")
			// Meta+backspace: the word rather than the character (`hello worl` was ink-text-input's answer).
			expect(samples).toContain("VALUE=[hello ]")
			expect(samples).toContain("VALUE=[hello there]")
			// Ctrl+W deletes a word.
			// Ink's resolved letter does not reach the value.
			expect(samples.at(-1)).toBe("VALUE=[hello ]")
			expect(samples).not.toContain("VALUE=[hello worldw]")
			expect(samples).not.toContain("VALUE=[hello therew]")
			expect(output).not.toMatch(/VALUE=\[[^\]]*w\]/u)
		},
		TEST_TIMEOUT_MS
	)

	it(
		"submits on Enter and leaves the value in place",
		async () => {
			const output = await driveInput(["portland", "\r"])

			expect(valueSamples(output)).toContain("VALUE=[portland]")
			expect(output).toContain("SUBMITTED=[portland]")
		},
		TEST_TIMEOUT_MS
	)
})
