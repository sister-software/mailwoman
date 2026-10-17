/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode ProcessTask}: line events, progress parsing, exit handling and disposal.
 */

import { describe, expect, it } from "vitest"

import { isProcessError, type ProcessProgress, ProcessTask, runProcess } from "#process"

function node(source: string): [string, string[]] {
	return [process.execPath, ["--eval", source]]
}

describe("ProcessTask", () => {
	it("dispatches each line per stream and resolves with the captured output", async () => {
		const lines: string[] = []
		const task = new ProcessTask(...node(`process.stdout.write("a\\nb"); process.stderr.write("c\\n")`))

		task.on("line", ({ stream, text }) => lines.push(`${stream}:${text}`))

		const result = await task.result

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe("a\nb")
		expect(result.stderr).toBe("c")
		expect(lines.toSorted()).toEqual(["stderr:c", "stdout:a", "stdout:b"])
	})

	it("treats a carriage return as a line end and dispatches parsed progress", async () => {
		const steps: ProcessProgress[] = []

		const task = new ProcessTask(...node(`process.stderr.write("Receiving 10%\\rReceiving 50%\\rReceiving 100%\\n")`), {
			progress: (line) => {
				const match = /^(\w+) (\d+)%$/u.exec(line)

				return match ? { stage: match[1]!, percent: Number(match[2]) } : null
			},
		})

		task.on("progress", (step) => steps.push(step))
		await task.result

		expect(steps.map((step) => step.percent)).toEqual([10, 50, 100])
	})

	it("rejects a non-zero exit with a ProcessError by default", async () => {
		const failure = await new ProcessTask(...node(`console.error("bad"); process.exit(3)`)).result.then(
			() => null,
			(error: unknown) => error
		)

		expect(isProcessError(failure)).toBe(true)
		expect(failure).toMatchObject({ code: 3, stderr: "bad" })
	})

	it("resolves a non-zero exit when reject is false", async () => {
		const result = await runProcess(...node(`console.log("out"); process.exit(3)`), { reject: false })

		expect(result.exitCode).toBe(3)
		expect(result.stdout).toBe("out")
	})

	it("rejects with the spawn error when the command cannot start", async () => {
		await expect(new ProcessTask("mailwoman-no-such-command", [], { reject: false }).result).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("stops a running process on disposal", async () => {
		const task = new ProcessTask(...node(`setInterval(() => {}, 1000)`), { reject: false })

		await task[Symbol.asyncDispose]()

		expect((await task.result).signal).toBe("SIGTERM")
	})

	it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
		const task = new ProcessTask(
			...node(`process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)`),
			{ reject: false, killGraceMs: 50 }
		)

		await new Promise<void>((resolve) => {
			task.on("line", () => resolve())
		})

		await task[Symbol.asyncDispose]()

		expect((await task.result).signal).toBe("SIGKILL")
	})

	it("stops the process when its signal aborts", async () => {
		const controller = new AbortController()
		const task = new ProcessTask(...node(`setInterval(() => {}, 1000)`), { reject: false, signal: controller.signal })

		controller.abort()

		expect((await task.result).signal).toBe("SIGTERM")
	})
})
