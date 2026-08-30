/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The regression for the debug view's input field, driven through a real pty because the defect it covers is about
 *   BYTES: what a terminal sends for alt+backspace, and what Ink's keypress parser makes of it. A component test can
 *   only assert what the harness decides to pass `useInput`, which is the same assumption that let the bug ship.
 *
 *   What the probe measured against `ink-text-input` 6.0.0 (the field this replaced), Ink 7.1.1, 2026-08-13:
 *
 *   - `\x17` (ctrl+W — the tty's `werase`, and what iTerm2 sends for ⌥⌫ by default) arrives as
 *       `input: "w", key.ctrl: true`, because Ink resolves ctrl+letter to the letter. `ink-text-input` guards only
 *       ctrl+C, so its insert branch typed the `w`: `hello world` → `hello worldw`. That is the reported
 *       "alt+backspace inserts a w".
 *   - `\x1b\x7f` (meta+backspace) arrives as `input: "", key.backspace + key.meta`, and was treated as a plain
 *       backspace — one character deleted, not one word.
 *
 *   Both sequences must now delete the word before the cursor, and neither may leave a letter behind.
 *
 *   `script` is util-linux's, and the `-e` / `-c` spelling is too; the suite skips where that isn't the `script` on
 *   PATH, exactly like `map-tui/cli.pty.test.ts`, which this harness is modelled on.
 */

import { isExecutable } from "@mailwoman/core/fs/readers"
import { spawn } from "@mailwoman/platform/child_process"
import { fileURLToPath } from "@mailwoman/platform/url"
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

const PROBE = fileURLToPath(new URL("../../../debug-view/test/input-probe.ts", import.meta.url))

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
	const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] })

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

	// Escape is the probe's quit; the kill is the belt-and-braces for a frame that never arrived.
	child.stdin.write(ESC)
	await delay(KEYSTROKE_GAP_MS)
	child.kill("SIGKILL")
	await exited

	return output
}

/**
 * Every `VALUE=[…]` the probe rendered, in stream order — the field's edit history. NOT de-duplicated: the same value
 * can be reached twice (both word deletes here land on `hello `), and a `Set` would hide the second behind the first,
 * which is exactly the assertion this test needs to make about the LAST frame.
 */
function valueSamples(output: string): string[] {
	// oxlint-disable-next-line no-control-regex -- stripping SGR from a pty capture IS matching a control character
	return output.replaceAll(/\u001B\[[\d;?]*[a-zA-Z]/gu, "").match(/VALUE=\[[^\]]*\]/gu) ?? []
}

describe.skipIf(!HAS_LINUX_SCRIPT)("debug-view input field (pty)", () => {
	it(
		"deletes the word before the cursor on meta+backspace and on ctrl+W, inserting nothing",
		async () => {
			const output = await driveInput(["hello world", META_BACKSPACE, "there", CTRL_W])
			const samples = valueSamples(output)

			expect(samples).toContain("VALUE=[hello world]")
			// Meta+backspace: the word, not the character (`hello worl` was ink-text-input's answer).
			expect(samples).toContain("VALUE=[hello ]")
			expect(samples).toContain("VALUE=[hello there]")
			// Ctrl+W landed as a word delete, and the letter Ink resolved it to never reached the value.
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
