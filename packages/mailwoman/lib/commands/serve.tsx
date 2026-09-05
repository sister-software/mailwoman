/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import cluster, { type Worker } from "node:cluster"

import { Spinner, StatusMessage } from "@inkjs/ui"
import type { ServerHandle } from "@mailwoman/api-kit"
import { isPresent } from "@mailwoman/core/objects"
import { availableParallelism } from "@mailwoman/core/utils/system"
// Default import, not `* as process` — the ESM namespace object for `node:process` only reflects
// the process object's OWN properties (`pid`, `exit`, `env`, …); EventEmitter methods (`on`, `once`,
// `emit`) live on its prototype chain and are silently absent from `import *`. SIGINT/SIGTERM below
// need `.once`, so this must be the real singleton.
import { Box, Text } from "ink"
import { useEffect, useState } from "react"

import type { CommandSpec, ParsedCommandComponent } from "#cli-kit"
import { printLicenseNotice, resolveEngineStamp } from "#cli-kit/engine-stamp"

interface ServerConfig {
	port: number
	host: string
	cpus?: number
}

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "serve",
	description: "Run the Mailwoman HTTP server",
	options: {
		port: { type: "number", default: 3000, description: "Port to listen on" },
		host: { type: "string", default: "0.0.0.0", description: "Network interface to bind" },
		cpus: { type: "number", description: "Worker processes. Default: every available core" },
	},
} as const satisfies CommandSpec

// NOTE(retrofit): long-running — exempt from useCommandTask (no one-shot task or exit-code dance to
// move: the process deliberately never exits, WorkerStatus is event-subscription UI with cleanup, and
// ChildThread's effect boots the @mailwoman/api Hono app over a node listener; there is no
// `setImmediate(process.exit)` here — SIGINT/SIGTERM now dispose the server after it drains).

const ClusterManager: ParsedCommandComponent<ServerConfig> = ({ options: { cpus = availableParallelism() } }) => {
	const [workers, setWorkers] = useState<Worker[]>()

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot cluster bootstrap; refactor pending
		setWorkers(Array.from({ length: cpus }, () => cluster.fork()))

		// Tracks whether ANY worker has ever reached "listening" — distinguishes a genuine boot
		// failure (every worker died before one of them opened the port) from an ordinary shutdown
		// after a healthy run. `cluster.on("listening", …)` mirrors the per-worker wiring in
		// WorkerStatus, but at the primary, where the exit handler below can see it.
		let anyListened = false
		let liveWorkerCount = cpus

		cluster.on("listening", () => {
			// One notice per server, from the primary, the first time a worker binds. The launcher's own notice prints
			// at exit, which for a daemon is the wrong moment.
			if (!anyListened) {
				void resolveEngineStamp().then(printLicenseNotice)
			}

			anyListened = true
		})

		cluster.on("exit", (worker, code, signal) => {
			console.log(`[${signal}] (${code}) Worker ${worker.process.pid} exited`)

			liveWorkerCount--

			if (liveWorkerCount === 0 && !anyListened) {
				// A boot that never listened is a failed boot — supervisors must see nonzero.
				process.exit(1)
			}
		})

		// Graceful shutdown: a TERM/INT delivered to the PRIMARY pid (docker stop, systemctl stop)
		// never reaches worker JS handlers — Node's cluster teardown bypasses them. Forward the
		// signal explicitly so each worker's serveNode drain actually runs, then exit once they're
		// gone (bounded — a hung worker must not wedge the shutdown).
		const forward = (signal: NodeJS.Signals) => {
			const alive = Object.values(cluster.workers ?? {}).filter(isPresent)

			if (!alive.length) {
				process.exit(0)
			}

			let remaining = alive.length

			for (const worker of alive) {
				// oxlint-disable-next-line no-loop-func -- the binding is per-iteration (for-of/for-await) and the batch is awaited before the next
				worker.once("exit", () => {
					remaining--

					if (remaining === 0) {
						process.exit(0)
					}
				})

				worker.process.kill(signal)
			}

			setTimeout(() => {
				// A wedged worker must not survive the primary holding the port.
				for (const worker of alive) {
					if (!worker.isDead()) {
						worker.process.kill("SIGKILL")
					}
				}

				process.exit(0)
			}, 10_000).unref()
		}

		process.once("SIGINT", () => forward("SIGINT"))
		process.once("SIGTERM", () => forward("SIGTERM"))
	}, [cpus])

	if (!workers) {
		return <Text>Starting workers...</Text>
	}

	return (
		<Box flexDirection="column">
			<Text>Manager process: {process.pid}</Text>

			<Text>Workers:</Text>

			{workers.map((worker) => (
				<WorkerStatus key={worker.id} worker={worker} />
			))}
		</Box>
	)
}

const WorkerStatus: React.FC<{ worker: Worker }> = ({ worker }) => {
	const [status, setStatus] = useState("pending")
	const [message, setMessage] = useState<string>()

	useEffect(() => {
		const onOnline = () => setStatus("online")
		const onExit = () => setStatus("exited")
		const onError = () => setStatus("error")
		const onListening = () => setStatus("listening")

		worker.on("online", onOnline)
		worker.on("exit", onExit)
		worker.on("error", onError)
		worker.on("listening", onListening)

		worker.on("message", (msg) => {
			setMessage(JSON.stringify(msg))
		})

		return () => {
			worker.off("online", onOnline)
			worker.off("exit", onExit)
			worker.off("error", onError)
			worker.off("listening", onListening)
		}
	}, [worker])

	if (status === "pending") {
		return <Spinner label="Starting worker..." />
	}

	if (status === "online") {
		return <StatusMessage variant="success">Online ({worker.process.pid})</StatusMessage>
	}

	if (status === "exited") {
		return <StatusMessage variant="error">Exited ({worker.process.pid})</StatusMessage>
	}

	if (status === "error") {
		return <StatusMessage variant="error">Error ({worker.process.pid})</StatusMessage>
	}

	if (status === "listening") {
		return (
			<StatusMessage variant="info">
				Listening ({worker.process.pid}) {message}
			</StatusMessage>
		)
	}

	return (
		<StatusMessage variant="error">
			Unknown status &quot;{status}&quot; ({worker.process.pid})
		</StatusMessage>
	)
}

const ChildThread: ParsedCommandComponent<ServerConfig> = ({ options: { port, host } }) => {
	useEffect(() => {
		let handle: ServerHandle | undefined
		let disposed = false

		void (async () => {
			const { createMailwomanAPI } = await import("@mailwoman/api")
			const { serveNode } = await import("@mailwoman/api-kit")
			const { $public } = await import("@mailwoman/core/env")
			const { createServeEngine } = await import("#api-engine")

			const { engine, preflight } = await createServeEngine()

			if (!preflight.ok) {
				// Every cluster worker runs createServeEngine() independently, so with --cpus N every one of
				// them hits this same failure and would print the identical banner N times. Node assigns
				// cluster worker `id`s synchronously (1, 2, 3, ...) at fork() time in the PRIMARY, before any
				// worker's async preflight resolves — so `cluster.worker.id === 1` deterministically picks the
				// FIRST-forked worker, regardless of which worker's preflight check happens to finish first.
				// Only that one worker prints; the rest exit silently. Chosen over a primary-side pre-fork
				// check (the primary doesn't otherwise call createServeEngine() at all, and duplicating its
				// import/db-existence check there just to avoid forking would be the more invasive change) and
				// over routing the message back through the primary's cluster "exit" handler (would require an
				// IPC round-trip for what's a one-line dedupe).
				if (cluster.worker?.id === 1) {
					console.error(preflight.message)
				}

				process.exit(1)
			}

			// 2 MiB body cap (accommodates a full /v1/batch up to MAILWOMAN_BATCH_MAX addresses) is
			// createMailwomanAPI's own default — carried from the express server's `express.json({ limit: "2mb" })`.
			const engineStamp = await resolveEngineStamp()

			const app = createMailwomanAPI(engine, {
				batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX),
				engine: engineStamp.stamp,
			})

			const server = await serveNode({
				fetch: app.fetch,
				port,
				hostname: host,
				onListen: () => cluster.worker?.send("HTTP server ready"),
			})

			if (disposed) {
				await server[Symbol.asyncDispose]()

				return
			}

			handle = server

			// Duplicate signal deliveries (group signal + primary forward) must be no-ops — the drain runs once.
			let draining = false

			const shutdown = () => {
				if (draining) return
				draining = true

				console.error(`[serve] worker ${process.pid} draining`)

				void handle?.[Symbol.asyncDispose]().finally(() => process.exit(0))
			}

			process.on("SIGINT", shutdown)
			process.on("SIGTERM", shutdown)
		})()

		return () => {
			disposed = true
			void handle?.[Symbol.asyncDispose]()
		}
	}, [host, port])

	return null
}

const ParseCommand = cluster.isPrimary ? ClusterManager : ChildThread

export default ParseCommand
