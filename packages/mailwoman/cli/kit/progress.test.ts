// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The test renders the progress feed in a subprocess against real Ink.
 *
 *   Ink writes its final frame at unmount.
 *   It strips ANSI codes before matching stdout.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { type ProcessProgress, runFile } from "@mailwoman/core/scripting/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { stripANSI } from "@mailwoman/core/strings/terminal"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { expect, test } from "vitest"

import { describeProgressStep, type ProgressStep, TransferProgress } from "#cli-kit"

/**
 * A stdout that claims to be a terminal and a stderr, both captured.
 *
 * A harness run with `tty` renders to them and prints both captures as JSON at the end.
 */
const TERMINAL = `
	import { Writable } from "node:stream"

	class Capture extends Writable {
		text = ""
		_write(chunk, _encoding, callback) {
			this.text += chunk.toString()
			callback()
		}
	}

	const tty = process.argv.includes("tty")
	const terminal = { stdout: Object.assign(new Capture(), { isTTY: true, columns: 80, rows: 24 }), stderr: new Capture() }
	const renderOptions = tty ? { ...terminal, interactive: true, patchConsole: false } : {}
	const printCaptures = () => tty && process.stdout.write(JSON.stringify({ stdout: terminal.stdout.text, stderr: terminal.stderr.text }))
`

interface Captures {
	stdout: string
	stderr: string
}

async function runHarness(harness: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	return runFile(process.execPath, ["--input-type=module", "-e", harness, ...args], {
		cwd: repoRootPath(),
		env: childEnv(),
	})
}

const HARNESS = `
	import { createElement as h, useEffect } from "react"
	import { render } from "ink"
	import { TypedEventTarget } from "@mailwoman/core/utils/events"
	import { ProgressLines, useProgressFeed } from "mailwoman/cli/kit"
	${TERMINAL}

	class Source extends TypedEventTarget {
		step(command, stage, percent) {
			this.emit("progress", { command, stage, percent, processed: percent / 10, total: 10 })
		}
	}

	const source = new Source()

	function View() {
		const feed = useProgressFeed()

		useEffect(() => feed.watch(source), [])

		return h(ProgressLines, { entries: feed.entries })
	}

	const app = render(h(View), renderOptions)

	setTimeout(() => {
		source.step("git clone a", "Receiving objects", 20)
		source.step("git clone a", "Receiving objects", 50)
		source.step("git clone b", "Resolving deltas", 100)
		setTimeout(() => {
			app.unmount()
			printCaptures()
		}, 50)
	}, 50)
`

/**
 * A local HTTP server answers three megabytes in three paced writes, and `streamToDisk`
 * reports them through a `TransferProgress` to the progress lines.
 *
 * Interactive rendering to the captured terminal keeps every frame.
 */
const DOWNLOAD_HARNESS = `
	import { createServer } from "node:http"
	import { createElement as h, useEffect } from "react"
	import { render } from "ink"
	import { streamToDisk } from "@mailwoman/core/utils"
	import { ProgressLines, TransferProgress, useProgressFeed } from "mailwoman/cli/kit"
	${TERMINAL}

	const MB = 1_000_000
	const server = createServer(async (_request, response) => {
		response.writeHead(200, { "content-length": String(3 * MB) })

		for (let part = 0; part < 3; part++) {
			response.write(Buffer.alloc(MB, part))
			await new Promise((resolve) => setTimeout(resolve, 150))
		}

		response.end()
	})

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

	const transfers = new TransferProgress()

	function View() {
		const feed = useProgressFeed()

		useEffect(() => feed.watch(transfers), [])

		return h(ProgressLines, { entries: feed.entries })
	}

	const app = render(h(View), renderOptions)
	const bytes = await streamToDisk({
		url: "http://127.0.0.1:" + server.address().port + "/object",
		destination: process.argv[1],
		context: "harness",
		onBytes: (received, total) => transfers.report("geo/object.db", received, total),
	})

	server.close()
	setTimeout(() => {
		app.unmount()
		terminal.stderr.text += "bytes " + bytes
		printCaptures()
	}, 50)
`

/**
 * A command that reports four stages through `useStageProgress`, the last without a detail, then exits.
 *
 * With `tty` it renders interactively to the captured terminal.
 * Without it, it renders through `renderInkCommand` to the piped stdio, as a detached command does.
 */
const STAGE_HARNESS = `
	import { createElement as h, useEffect } from "react"
	import { render, useApp } from "ink"
	import { renderInkCommand, StageLine, useStageProgress } from "mailwoman/cli/kit"
	${TERMINAL}

	const STEPS = [["download", "1 of 2 files"], ["download", "2 of 2 files"], ["index", "built 3 rows"], ["verify"]]

	function View() {
		const progress = useStageProgress()
		const { exit } = useApp()

		useEffect(() => {
			let next = 0
			const timer = setInterval(() => {
				if (next < STEPS.length) return progress.report(...STEPS[next++])

				clearInterval(timer)
				process.stderr.write("before exit\\n")
				exit()
			}, 60)

			return () => clearInterval(timer)
		}, [])

		return h(StageLine, { progress })
	}

	if (tty) {
		const app = render(h(View), renderOptions)

		await app.waitUntilExit()
		printCaptures()
	} else {
		await renderInkCommand(h(View))
	}
`

/**
 * A plain stderr line: the ISO UTC time, the bracketed name, and the detail when the report gave one.
 */
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[([^\]]+)\](?: (.+))?$/u

function logLines(stderr: string): Array<string | [string, string | undefined]> {
	return [...stripANSI(stderr).matchAll(/^.+$/gmu)].map(([line]) => {
		const match = LOG_LINE.exec(line)

		return match ? [match[1]!, match[2]] : line
	})
}

test("without a terminal, each stage is a timestamped stderr line written before exit, and no frame repeats it", async () => {
	const { stdout, stderr } = await runHarness(STAGE_HARNESS)

	expect(logLines(stderr)).toEqual([
		["download", "1 of 2 files"],
		["download", "2 of 2 files"],
		["index", "built 3 rows"],
		["verify", undefined],
		"before exit",
	])

	// A stage without a detail ends at its bracket, with no trailing space.
	expect(stripANSI(stderr)).toMatch(/Z \[verify\]\n/u)
	expect(stripANSI(stdout)).not.toContain("files")
}, 30_000)

test("on a terminal, the latest stage is drawn in the frame and nothing goes to stderr", async () => {
	const captured = parseJSONStrict<Captures>((await runHarness(STAGE_HARNESS, "tty")).stdout)
	const frames = stripANSI(captured.stdout)

	expect(frames).toContain("[download] 1 of 2 files")
	expect(frames).toContain("[download] 2 of 2 files")
	expect(frames).toContain("[index] built 3 rows")
	expect(frames).toMatch(/\[verify\]\n/u)
	expect(captured.stderr).toBe("")
}, 30_000)

test("without a terminal, the feed writes each step to stderr as a timestamped line without the bar", async () => {
	const { stdout, stderr } = await runHarness(HARNESS)

	expect(logLines(stderr)).toEqual([
		["git clone a", "20%  Receiving objects  (2/10)"],
		["git clone a", "50%  Receiving objects  (5/10)"],
		["git clone b", "100%  Resolving deltas  (10/10)"],
	])

	expect(stripANSI(stdout)).not.toContain("Receiving")
}, 30_000)

test("TransferProgress emits a step only when the whole percent or, without a total, the megabyte changes", () => {
	const transfers = new TransferProgress({ now: () => 0 })
	const steps: ProcessProgress[] = []

	transfers.on("progress", ({ command: _command, ...step }) => steps.push(step))

	for (const received of [0, 100, 9999, 10_000, 10_001, 1_000_000]) {
		transfers.report("sized", received, 1_000_000)
	}

	for (const received of [500_000, 999_999, 1_000_000, 1_500_000]) {
		transfers.report("unsized", received, null)
	}

	expect(steps.map((step) => step.percent)).toEqual([0, 1, 100, undefined, undefined])
	expect(steps.at(2)?.stage).toBe(`${ByteFormatter.formatSI(1_000_000)} of ${ByteFormatter.formatSI(1_000_000)}`)
	expect(steps.at(-1)?.stage).toBe(ByteFormatter.formatSI(1_000_000))
})

test("draws a local download's bytes, total and percent as it arrives", async () => {
	await using scratch = await temporaryDirectory()
	const destination = scratch.path("object.db")

	const { stdout, stderr } = parseJSONStrict<Captures>(
		(await runHarness(DOWNLOAD_HARNESS, destination.toString(), "tty")).stdout
	)

	const total = ByteFormatter.formatSI(3_000_000)

	// Where the frames fall depends on how the socket splits the writes, so only their order is fixed.
	const percents = [
		...stripANSI(stdout).matchAll(new RegExp(`geo/object\\.db: [█░]+\\s+(\\d+)%\\s+.+ of ${total}`, "gu")),
	].map((match) => Number(match[1]))

	expect(stderr).toContain("bytes 3000000")
	expect(percents.some((percent) => percent > 0 && percent < 100)).toBe(true)
	expect(percents).toEqual(percents.toSorted((a, b) => a - b))
	expect(percents.at(-1)).toBe(100)
	expect(stripANSI(stdout)).toContain(`geo/object.db: ${"█".repeat(24)}  100%  ${total} of ${total}`)
}, 30_000)

test("on a terminal, renders the latest step per command", async () => {
	const text = stripANSI(parseJSONStrict<Captures>((await runHarness(HARNESS, "tty")).stdout).stdout)

	expect(text).toMatch(/git clone a: [█░]{24}\s+50%\s+Receiving objects\s+\(5\/10\)/u)
	expect(text).toMatch(/git clone b: █{24}\s+100%\s+Resolving deltas\s+\(10\/10\)/u)
	expect(text).not.toContain("20%")
}, 30_000)

test("TransferProgress reports the average rate and the time remaining once a second has passed", () => {
	let clock = 0
	const transfers = new TransferProgress({ now: () => clock })
	const steps: Array<ProgressStep & { command: string }> = []

	transfers.on("progress", (step) => steps.push(step))

	transfers.report("db", 0, 1000)

	clock = 500
	transfers.report("db", 100, 1000)

	clock = 2000
	transfers.report("db", 250, 1000)

	// The percent is unchanged and the refresh interval has passed, so the step is emitted again with a new rate.
	clock = 3000
	transfers.report("db", 259, 1000)

	expect(steps.map((step) => step.percent)).toEqual([0, 10, 25, 25])
	expect(steps[1]?.bytesPerSecond).toBeUndefined()
	expect(steps[2]).toMatchObject({ bytesPerSecond: 125, secondsRemaining: 6 })

	expect(describeProgressStep("db", steps[2]!)).toBe(
		`db: ${"█".repeat(6)}${"░".repeat(18)}   25%  ${ByteFormatter.formatSI(250)} of ${ByteFormatter.formatSI(1000)}` +
			`  ${ByteFormatter.formatSI(125)}/s  6s left`
	)
})

test("TransferProgress at ten percent per step, without a refresh interval, emits one step per tenth", () => {
	let clock = 0
	const transfers = new TransferProgress({ percentStep: 10, refreshMs: Infinity, now: () => clock })
	const tenths: number[] = []

	transfers.on("progress", (step) => tenths.push(Math.floor((step.percent ?? -1) / 10)))

	for (let received = 0; received <= 1000; received += 7) {
		clock += 1000
		transfers.report("db", received, 1000)
	}

	transfers.report("db", 1000, 1000)

	expect(tenths).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test("describeProgressStep writes the time remaining in minutes or hours, and omits it at 100%", () => {
	const step = (secondsRemaining: number): ProgressStep => ({ stage: "s", percent: 50, secondsRemaining })

	expect(describeProgressStep("k", step(125))).toMatch(/2m 05s left$/u)
	expect(describeProgressStep("k", step(4320))).toMatch(/1h 12m left$/u)
	expect(describeProgressStep("k", { stage: "s", percent: 100, secondsRemaining: 0 })).not.toContain("left")
})
