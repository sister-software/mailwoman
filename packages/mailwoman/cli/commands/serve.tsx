// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import cluster, { type Worker } from "node:cluster"

import { Spinner, StatusMessage } from "@inkjs/ui"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { allKeyed } from "@mailwoman/core/promises"
import { availableParallelism } from "@mailwoman/core/utils/system"
// Default import rather than `* as process`.
// The ESM namespace object for `node:process` only reflects the process object's own
// properties (`pid`, `exit`, `env`, …); EventEmitter methods (`on`, `once`, `emit`)
// live on its prototype chain and are silently absent from `import *`. sigint/sigterm
// below need `.once`, so this must be the real singleton.
import { Box, Text } from "ink"
import { useEffect, useState } from "react"

import type { CommandSpec, ParsedCommandComponent } from "#cli-kit"
import { primaryActionAfterWorkerExit, WORKER_RESPAWN_LIMIT, WORKER_RESPAWN_WINDOW_MS } from "#cli/kit/cluster/exit"
import { clusterReload, relayClusterReloads } from "#cli/kit/cluster/reload"
import { printLicenseNotice, resolveEngineStamp } from "#cli/kit/engine-stamp"

interface ServerConfig {
	port: number
	host: string
	cpus?: number
}

/**
 * Native command-line interface consumed by the filesystem command router.
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

// note(retrofit): long-running — exempt from useCommandTask (no one-shot task or exit-code sequence
// to move: the process deliberately never exits. WorkerStatus is event-subscription UI with
// cleanup. ChildThread's effect boots the @mailwoman/api Hono app over a node listener. There's
// no `setImmediate(process.exit)` here — sigint/sigterm now dispose the server after it drains).

const ClusterManager: ParsedCommandComponent<ServerConfig> = ({ options: { cpus = availableParallelism() } }) => {
	const [workers, setWorkers] = useState<Worker[]>()

	useEffect(() => {
		relayClusterReloads()

		// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot cluster bootstrap. refactor pending
		setWorkers(Array.from({ length: cpus }, () => cluster.fork()))

		// Tracks whether any worker has ever reached "listening" — distinguishes a
		// boot failure (every worker died before one of them opened the port) from
		// an ordinary shutdown after a healthy run.
		// `cluster.on("listening", …)` mirrors the per-worker wiring in WorkerStatus,
		// but at the primary, where the exit handler below can see it.
		let anyListened = false
		let liveWorkerCount = cpus
		let shuttingDown = false
		// The ids of the workers that have bound the port, so an exit can tell a serving worker from a boot failure.
		const listened = new Set<number>()
		// When each replacement inside the respawn window was forked, in epoch milliseconds.
		let respawns: number[] = []

		cluster.on("listening", (worker) => {
			// One notice per server, from the primary, the first time a worker binds.
			// The launcher prints its own notice at exit.
			// A daemon needs the notice when a worker binds.
			if (!anyListened) {
				void resolveEngineStamp().then(printLicenseNotice)
			}

			anyListened = true
			listened.add(worker.id)
		})

		cluster.on("exit", (worker, code, signal) => {
			console.log(`[${signal}] (${code}) Worker ${worker.process.pid} exited`)

			liveWorkerCount--

			const now = Date.now()

			respawns = respawns.filter((at) => now - at < WORKER_RESPAWN_WINDOW_MS)

			const workerListened = listened.delete(worker.id)

			const action = primaryActionAfterWorkerExit({
				liveWorkers: liveWorkerCount,
				anyListened,
				shuttingDown,
				workerListened,
				recentRespawns: respawns.length,
			})

			// A serving worker that isn't replaced has reached the bound, and the operator needs the reason.
			if (workerListened && !shuttingDown && !action?.respawn) {
				console.error(
					`serve: worker ${worker.process.pid} isn't replaced, after ${WORKER_RESPAWN_LIMIT} replacements ` +
						`in ${WORKER_RESPAWN_WINDOW_MS / 1000} seconds`
				)
			}

			if (!action) return

			if (!action.respawn) {
				console.error(`serve: ${action.reason}`)

				process.exit(action.code)
			}

			const replacement = cluster.fork()

			respawns.push(now)

			liveWorkerCount++

			console.error(`serve: forked worker ${replacement.process.pid} to replace worker ${worker.process.pid}`)

			setWorkers((current) => [...(current ?? []).filter((known) => known !== worker), replacement])
		})

		// Graceful shutdown: a term/INT delivered to the primary pid (docker stop, systemctl stop)
		// never reaches worker JS handlers — Node's cluster teardown bypasses them.
		// Forward the signal explicitly so each worker's serveNode drain runs, then exit
		// once they're gone (bounded — a hung worker mustn't wedge the shutdown).
		const forward = (signal: NodeJS.Signals) => {
			shuttingDown = true

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
				// A wedged worker mustn't survive the primary holding the port.
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
			setMessage(stringifyJSON(msg))
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
		let handle: AsyncDisposable | null = null
		let disposed = false

		void (async () => {
			const {
				api: { createMailwomanAPI, MAILWOMAN_API_DOC_INFO },
				apiKit: { serveNode },
				env: { $public },
				apiEngine: { createServeEngine },
			} = await allKeyed({
				api: import("@mailwoman/api"),
				apiKit: import("@mailwoman/api-kit"),
				env: import("#env"),
				apiEngine: import("#api-engine"),
			})

			const serveEngine = await createServeEngine()
			const { preflight } = serveEngine

			// A reload in any worker reloads every worker.
			const engine = serveEngine.engine.reload
				? { ...serveEngine.engine, reload: clusterReload(serveEngine.engine.reload) }
				: serveEngine.engine

			if (!preflight.ok) {
				// Every cluster worker runs createServeEngine() independently, so with --cpus N every
				// one of them hits this same failure and would print the identical banner N times.
				// Node assigns cluster worker `id`s synchronously (1, 2, 3, ...) at fork()
				// time in the primary, before any worker's async preflight resolves —
				// so `cluster.worker.id === 1` deterministically picks the first-forked worker,
				// regardless of which worker's preflight check happens to finish first.
				// Only that one worker prints.
				// The rest exit silently.
				// Chosen over a primary-side pre-fork check
				// (the primary doesn't otherwise call createServeEngine() at all. An import
				// and database-existence check there only to avoid forking would change more code)
				// and over routing the message back through the primary's cluster "exit" handler
				// (would require an IPC round-trip for what's a one-line dedupe).
				if (cluster.worker?.id === 1) {
					console.error(preflight.message)
				}

				process.exit(1)
			}

			// 2 MiB body cap (accommodates a full /v1/batch up to MAILWOMAN_BATCH_MAX addresses)
			// is createMailwomanAPI's own default — inherited from the express
			// server's `express.json({ limit: "2mb" })`.
			const engineStamp = await resolveEngineStamp()

			const app = createMailwomanAPI(engine, {
				batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX),
				engine: engineStamp.stamp,
				docInfo: MAILWOMAN_API_DOC_INFO,
			})

			const server = await serveNode({
				fetch: app.fetch,
				port,
				hostname: host,
				// The line states the bound port.
				// It differs from `--port` when `--port` is 0.
				onListen: (info) => {
					console.error(`[mailwoman] native /v1 API listening on http://${info.address}:${info.port}`)

					cluster.worker?.send("HTTP server ready")
				},
			})

			// The listener drains its connections before the engine closes the sessions they read.
			const closeAll = async () => {
				await server[Symbol.asyncDispose]()
				await serveEngine[Symbol.asyncDispose]()
			}

			if (disposed) {
				await closeAll()

				return
			}

			handle = { [Symbol.asyncDispose]: closeAll }

			// Duplicate signal deliveries (group signal + primary forward) must be no-ops — the drain runs once.
			let draining = false

			const shutdown = () => {
				if (draining) return
				draining = true

				console.error(`[serve] worker ${process.pid} draining`)

				void closeAll().finally(() => process.exit(0))
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
