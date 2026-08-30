/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shim's half of the worker protocol: fork, handshake, call correlation, restart, crash policy.
 *
 *   IMPORT DISCIPLINE — the reason this file exists apart from `worker.ts`: everything here must be loadable by the
 *   never-stale shim, so it imports Node builtins only. Importing anything from the mailwoman graph (even a type-only
 *   module that transitively reaches runtime code) would re-create the staleness the split removes. The worker's
 *   message shapes are re-declared structurally rather than imported for exactly that reason; the protocol test forks
 *   the REAL worker, so a drift between the two declarations fails there, not silently.
 *
 *   Restart semantics, stated where a caller will read them:
 *
 *   - In-flight tool calls are REJECTED with a restart error — they were running against the old module graph and
 *     their results would be unattributable.
 *   - Background jobs die with the child (the worker's SIGTERM handler cancels them); the restart result carries the
 *     aborted-call count so nothing disappears silently.
 *   - Engines are rebuilt lazily by the next call, per the registry's own contract.
 *
 *   Crash policy: an unexpected exit rejects all pending calls and respawns once, immediately. Three unexpected exits
 *   inside a minute mark the host DEGRADED — further calls fail fast with the child's last stderr tail — because a
 *   crash-looping child burning engine boots is worse than a loud outage. `restart()` always clears the degraded
 *   state: it is the operator-intent signal.
 */

import { type ChildProcess, fork } from "@mailwoman/platform/child_process"
import { once } from "@mailwoman/platform/events"

export interface WorkerToolMeta {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

interface ReadyMessage {
	type: "ready"
	pid: number
	bootFingerprint: string
	tools: WorkerToolMeta[]
}

interface ResultMessage {
	type: "result"
	id: number
	ok: boolean
	value?: unknown
	error?: string
}

type WorkerMessage = ReadyMessage | ResultMessage

export interface WorkerHostOptions {
	/**
	 * Absolute path to the worker entry module. A parameter rather than a constant so the crash/restart implementation is
	 * testable against a stub child that can be told to hang, crash, or answer garbage.
	 */
	workerPath: string
	workerArgs: string[]
	/**
	 * Milliseconds to wait for the handshake before declaring a boot failure. The worker's boot imports the whole
	 * mailwoman graph, which is seconds, not milliseconds.
	 */
	handshakeTimeoutMs?: number
	/**
	 * Where the child's stdout/stderr are drained to. Defaults to the host process's stderr — NEVER stdout, which on the
	 * shim is the MCP channel.
	 */
	log?: NodeJS.WritableStream
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000

/**
 * Unexpected exits inside {@link CRASH_WINDOW_MS} before the host refuses to respawn on its own.
 */
const CRASH_LIMIT = 3
const CRASH_WINDOW_MS = 60_000

/**
 * How long a SIGTERM'd child gets to run its cleanup handler before SIGKILL. Generous because the worker's teardown
 * closes SQLite handles and cancels spawned jobs.
 */
const TERM_GRACE_MS = 5000

export interface RestartReport {
	previous_pid: number | null
	previous_boot_fingerprint: string | null
	new_pid: number
	new_boot_fingerprint: string
	tools_changed: boolean
	aborted_calls: number
}

export class WorkerHost implements AsyncDisposable {
	readonly #options: Required<Pick<WorkerHostOptions, "workerPath" | "workerArgs" | "handshakeTimeoutMs">> & {
		log: NodeJS.WritableStream
	}
	#child: ChildProcess | null = null
	#ready: ReadyMessage | null = null
	#nextID = 1
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	#crashTimes: number[] = []
	#degraded: string | null = null
	#stderrTail = ""
	/**
	 * True while {@link restart} or disposal intentionally kills the child, so the exit handler can tell an ordered death
	 * from a crash.
	 */
	#expectingExit = false

	constructor(options: WorkerHostOptions) {
		this.#options = {
			workerPath: options.workerPath,
			workerArgs: options.workerArgs,
			handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
			log: options.log ?? process.stderr,
		}
	}

	get tools(): WorkerToolMeta[] {
		return this.#ready?.tools ?? []
	}

	get bootFingerprint(): string | null {
		return this.#ready?.bootFingerprint ?? null
	}

	get pid(): number | null {
		return this.#ready?.pid ?? null
	}

	get degradedReason(): string | null {
		return this.#degraded
	}

	async start(): Promise<void> {
		const child = fork(this.#options.workerPath, this.#options.workerArgs, {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			// A clean argv: inherited inspector/debug flags would collide on ports across respawns.
			execArgv: [],
		})

		child.stdout?.on("data", (chunk: Buffer) => this.#options.log.write(chunk))

		child.stderr?.on("data", (chunk: Buffer) => {
			this.#options.log.write(chunk)
			this.#stderrTail = (this.#stderrTail + chunk.toString()).slice(-4096)
		})

		child.on("message", (message: WorkerMessage) => this.#onMessage(message))
		child.on("exit", (code, signal) => this.#onExit(code, signal))

		this.#child = child

		const ready = new Promise<ReadyMessage>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`worker handshake timed out after ${this.#options.handshakeTimeoutMs}ms`)),
				this.#options.handshakeTimeoutMs
			)

			const onMessage = (message: WorkerMessage): void => {
				if (message.type === "ready") {
					clearTimeout(timer)
					child.off("message", onMessage)
					resolve(message)
				}
			}

			child.on("message", onMessage)

			child.once("exit", (code) => {
				clearTimeout(timer)
				reject(new Error(`worker exited during handshake (code ${code}). Last stderr:\n${this.#stderrTail}`))
			})
		})

		child.send({ type: "handshake" })
		this.#ready = await ready
	}

	async call(name: string, args: Record<string, unknown>): Promise<unknown> {
		if (this.#degraded) {
			throw new Error(
				`The worker is DEGRADED (${this.#degraded}). Call mwdev_restart to respawn it deliberately; the host ` +
					"stopped auto-respawning after repeated crashes rather than burn engine boots in a loop."
			)
		}

		const child = this.#child

		if (!child || !child.connected) {
			throw new Error("The worker is not running. Call mwdev_restart.")
		}

		const id = this.#nextID++

		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject })
			child.send({ type: "call", id, name, args })
		})
	}

	/**
	 * Kill the child and fork a fresh one — a fresh ES module graph, i.e. the running server picks up edited source.
	 */
	async restart(): Promise<RestartReport> {
		const previousPID = this.pid
		const previousFingerprint = this.bootFingerprint
		// The FULL metas, not the names: a restart that adds a parameter changes what a client may send, and a
		// name-only compare suppressed the tools/list_changed the client needed to drop its stale schema.
		const previousTools = JSON.stringify(this.tools)

		const aborted = this.#rejectPending(
			new Error("The worker was restarted; this call died with the old module graph. Re-run it.")
		)

		await this.#stopChild()
		this.#degraded = null
		this.#crashTimes = []
		this.#ready = null

		await this.start()

		return {
			previous_pid: previousPID,
			previous_boot_fingerprint: previousFingerprint,
			new_pid: this.pid!,
			new_boot_fingerprint: this.bootFingerprint!,
			tools_changed: JSON.stringify(this.tools) !== previousTools,
			aborted_calls: aborted,
		}
	}

	/**
	 * End the worker at scope exit: reject every in-flight call, then stop the child.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		this.#rejectPending(new Error("The server is shutting down."))
		await this.#stopChild()
	}

	#onMessage(message: WorkerMessage): void {
		if (message.type !== "result") return

		const pending = this.#pending.get(message.id)

		if (!pending) return

		this.#pending.delete(message.id)

		if (message.ok) {
			pending.resolve(message.value)
		} else {
			pending.reject(new Error(message.error ?? "worker returned an unlabeled failure"))
		}
	}

	#onExit(code: number | null, signal: string | null): void {
		if (this.#expectingExit) return

		this.#rejectPending(
			new Error(`The worker died mid-call (code ${code}, signal ${signal}). Last stderr:\n${this.#stderrTail}`)
		)

		const now = Date.now()

		this.#crashTimes = [...this.#crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now]
		this.#ready = null
		this.#child = null

		if (this.#crashTimes.length >= CRASH_LIMIT) {
			this.#degraded = `${this.#crashTimes.length} unexpected exits within ${CRASH_WINDOW_MS / 1000}s; last stderr tail:\n${this.#stderrTail}`

			return
		}

		// One immediate respawn: a lazily-booted worker is cheap to bring back, and a transient death (OOM kill during
		// a heavy board run) should not take the whole surface down.
		void this.start().catch((error: unknown) => {
			this.#degraded = `respawn failed: ${error instanceof Error ? error.message : String(error)}`
		})
	}

	async #stopChild(): Promise<void> {
		const child = this.#child

		if (!child) return

		this.#expectingExit = true

		try {
			if (child.connected) {
				child.kill("SIGTERM")
			}

			const grace = setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS)

			if (child.exitCode === null && child.signalCode === null) {
				await once(child, "exit")
			}

			clearTimeout(grace)
		} finally {
			this.#expectingExit = false
			this.#child = null
		}
	}

	#rejectPending(error: Error): number {
		const count = this.#pending.size

		for (const { reject } of this.#pending.values()) {
			reject(error)
		}

		this.#pending.clear()

		return count
	}
}
