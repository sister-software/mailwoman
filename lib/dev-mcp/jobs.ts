import { type ChildProcess, spawnProcess } from "@mailwoman/core/process"
import { defineStateMachine } from "@mailwoman/core/state-machine"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Long-running child processes, polled rather than awaited: a gauntlet outlives what a synchronous tool call should
 *   hold open. An MCP client that times out mid-run leaves the work orphaned and reports no result.
 *
 *   Output is captured rather than inherited because this process speaks JSON-RPC over stdout, so a child writing there
 *   would corrupt the transport — which is also why the gauntlet is spawned rather than imported.
 */

export type JobState = "running" | "succeeded" | "failed" | "cancelled"

/**
 * What the registry observes about a job's child process.
 *
 * `error` is Node's `ChildProcess` event.
 * It fires when the process couldn't be spawned and when `kill()` couldn't deliver its signal.
 */
export type JobEvent =
	| { kind: "close"; code: number | null; signal: NodeJS.Signals | null }
	| { kind: "error" }
	| { kind: "cancel" }

/**
 * The state a job moves to on an event.
 *
 * Only `running` moves on a close or an error.
 * A cancelled job stays cancelled through its close and through a failed kill,
 * so a killed run never reads as a graded `fail`.
 * `succeeded` and `failed` are terminal.
 */
function nextJobState(state: JobState, event: JobEvent): JobState {
	return jobMachine.transition(state, event).next
}

/**
 * A dev-mcp job's lifecycle.
 *
 * Its state lives in the registry's memory.
 * Each step holds an empty record and an empty effect list.
 */
export const jobMachine = defineStateMachine<JobState, JobEvent>({
	name: "job",
	states: ["running", "succeeded", "failed", "cancelled"],
	events: {
		"exit 0": { kind: "close", code: 0, signal: null },
		"exit 1": { kind: "close", code: 1, signal: null },
		"killed by SIGTERM": { kind: "close", code: null, signal: "SIGTERM" },
		"spawn or kill error": { kind: "error" },
		cancel: { kind: "cancel" },
	},
	transition(state, event) {
		const step = (next: JobState) => ({ next, record: {}, effects: [] })

		if (state !== "running") return step(state)

		switch (event.kind) {
			case "cancel":
				return step("cancelled")
			case "error":
				return step("failed")
			case "close":
				if (event.signal) return step("cancelled")

				return step(event.code === 0 ? "succeeded" : "failed")
		}
	},
})

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
 * A gauntlet log is tens of kilobytes, so this is generous enough that no real run
 * is truncated while bounding a runaway child's heap.
 *
 * Truncation goes in the tail marker rather than being silently applied, because a
 * log that lost its end would hide the verdict that prints last.
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
	 * Spawn a child and track it, returning immediately rather than awaiting the child.
	 */
	start(label: string, command: string, args: string[], cwd: string): Job {
		const jobID = `job-${++this.#counter}`
		const child = spawnProcess(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })

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
			job.state = nextJobState(job.state, { kind: "close", code, signal })
		})

		child.on("error", (error) => {
			// After a cancel, the error is a kill that failed, and the process may still run.
			// The job keeps its child so `cancelAll` can kill it again.
			if (job.state === "cancelled") {
				job.stderr = appendCapped(job.stderr, `\n[jobs] kill failed: ${error.message}\n`)

				return
			}

			job.endedAt = Date.now()
			job.state = nextJobState(job.state, { kind: "error" })
			job.stderr = appendCapped(job.stderr, `\n[jobs] spawn failed: ${error.message}\n`)
			job.child = null
		})

		this.#jobs.set(jobID, job)

		return job
	}

	get(jobID: string): Job | null {
		return this.#jobs.get(jobID) ?? null
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

		job.state = nextJobState(job.state, { kind: "cancel" })
		job.child.kill("SIGTERM")

		return true
	}

	/**
	 * Called on shutdown so a killed server doesn't leave orphaned gauntlets
	 * holding multi-gigabyte SQLite handles.
	 */
	cancelAll(): number {
		let cancelled = 0

		for (const job of this.#jobs.values()) {
			if (job.child) {
				job.state = nextJobState(job.state, { kind: "cancel" })
				job.child.kill("SIGTERM")

				cancelled++
			}
		}

		return cancelled
	}
}
