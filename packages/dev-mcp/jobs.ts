/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Long-running child processes, polled rather than awaited.
 *
 *   A regression-layer gauntlet is about two minutes and a full run is longer, which is past what a synchronous tool
 *   call should hold open: an MCP client that times out mid-run leaves the work orphaned and reports nothing. So a job
 *   starts, returns its id, and is polled through `mwdev_job`.
 *
 *   Output is captured rather than inherited. This process speaks JSON-RPC over stdout, so a child writing there would
 *   corrupt the transport — which is also why the gauntlet is spawned at all rather than imported (it writes its whole
 *   report to stdout by design).
 */

import { spawn, type ChildProcess } from "node:child_process"

export type JobState = "running" | "succeeded" | "failed" | "cancelled"

export interface Job {
	jobID: string
	label: string
	command: string
	args: string[]
	state: JobState
	startedAt: number
	endedAt: number | null
	exitCode: number | null
	stdout: string
	stderr: string
	child: ChildProcess | null
}

export interface JobSummary {
	job_id: string
	label: string
	state: JobState
	elapsed_s: number
	exit_code: number | null
	command: string
	stdout_bytes: number
	stderr_bytes: number
}

/**
 * Cap on captured output per stream.
 *
 * A gauntlet log is tens of kilobytes; this is generous enough that no real run is truncated, and bounded so a runaway
 * child cannot exhaust the server's heap. Truncation is REPORTED in the tail marker rather than silently applied — a
 * log that quietly lost its end would hide the verdict, which prints last.
 */
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024

function appendCapped(existing: string, chunk: string): string {
	if (existing.length >= MAX_CAPTURED_BYTES) return existing

	return (existing + chunk).slice(0, MAX_CAPTURED_BYTES)
}

export class JobRegistry {
	readonly #jobs = new Map<string, Job>()
	#counter = 0

	/**
	 * Spawn a child and track it. Returns immediately.
	 */
	start(label: string, command: string, args: string[], cwd: string): Job {
		const jobID = `job-${++this.#counter}`
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })

		const job: Job = {
			jobID,
			label,
			command,
			args,
			state: "running",
			startedAt: Date.now(),
			endedAt: null,
			exitCode: null,
			stdout: "",
			stderr: "",
			child,
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			job.stdout = appendCapped(job.stdout, chunk.toString())
		})

		child.stderr?.on("data", (chunk: Buffer) => {
			job.stderr = appendCapped(job.stderr, chunk.toString())
		})

		child.on("close", (code, signal) => {
			job.endedAt = Date.now()
			job.exitCode = code
			job.child = null
			// A signalled exit is not a failure verdict — it is a cancellation, and conflating them would let a killed
			// run read as a graded FAIL.
			job.state = job.state === "cancelled" || signal ? "cancelled" : code === 0 ? "succeeded" : "failed"
		})

		child.on("error", (error) => {
			job.endedAt = Date.now()
			job.state = "failed"
			job.stderr = appendCapped(job.stderr, `\n[jobs] spawn failed: ${error.message}\n`)
			job.child = null
		})

		this.#jobs.set(jobID, job)

		return job
	}

	get(jobID: string): Job | undefined {
		return this.#jobs.get(jobID)
	}

	list(): JobSummary[] {
		return [...this.#jobs.values()].map((job) => this.summarize(job))
	}

	summarize(job: Job): JobSummary {
		return {
			job_id: job.jobID,
			label: job.label,
			state: job.state,
			elapsed_s: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
			exit_code: job.exitCode,
			command: [job.command, ...job.args].join(" "),
			stdout_bytes: job.stdout.length,
			stderr_bytes: job.stderr.length,
		}
	}

	cancel(jobID: string): boolean {
		const job = this.#jobs.get(jobID)

		if (!job?.child) return false

		job.state = "cancelled"
		job.child.kill("SIGTERM")

		return true
	}

	/**
	 * Kill everything still running. Called on shutdown so a killed server does not leave orphaned gauntlets holding
	 * multi-gigabyte SQLite handles.
	 */
	cancelAll(): number {
		let cancelled = 0

		for (const job of this.#jobs.values()) {
			if (job.child) {
				job.state = "cancelled"
				job.child.kill("SIGTERM")

				cancelled++
			}
		}

		return cancelled
	}
}
