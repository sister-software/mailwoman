/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import cluster, { type Worker } from "node:cluster"
import { availableParallelism } from "node:os"
// Default import, not `* as process` — the ESM namespace object for `node:process` only reflects
// the process object's OWN properties (`pid`, `exit`, `env`, …); EventEmitter methods (`on`, `once`,
// `emit`) live on its prototype chain and are silently absent from `import *`. SIGINT/SIGTERM below
// need `.once`, so this must be the real singleton.
import process from "node:process"

import { Spinner, StatusMessage } from "@inkjs/ui"
import { createMailwomanAPI } from "@mailwoman/api"
import { serveNode, type ServerHandle } from "@mailwoman/api-kit"
import { $public } from "@mailwoman/core/env"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import { createServeEngine } from "../api-engine.ts"
import type { CommandComponent } from "../cli-kit/index.ts"

// NOTE(retrofit): long-running — exempt from useCommandTask (no one-shot task or exit-code dance to
// move: the process deliberately never exits, WorkerStatus is event-subscription UI with cleanup, and
// ChildThread's effect boots the @mailwoman/api Hono app over a node listener; there is no
// `setImmediate(process.exit)` here — SIGINT/SIGTERM now drive an explicit graceful `server.close()`).

const ClusterManager: CommandComponent<typeof ServerConfigSchema> = ({
	options: { cpus = availableParallelism() },
}) => {
	const [workers, setWorkers] = useState<Worker[]>()

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot cluster bootstrap; refactor pending
		setWorkers(Array.from({ length: cpus }, () => cluster.fork()))

		cluster.on("exit", (worker, code, signal) => {
			console.log(`[${signal}] (${code}) Worker ${worker.process.pid} exited`)
		})

		// Graceful shutdown: a TERM/INT delivered to the PRIMARY pid (docker stop, systemctl stop)
		// never reaches worker JS handlers — Node's cluster teardown bypasses them. Forward the
		// signal explicitly so each worker's serveNode drain actually runs, then exit once they're
		// gone (bounded — a hung worker must not wedge the shutdown).
		const forward = (signal: NodeJS.Signals) => {
			const alive = Object.values(cluster.workers ?? {}).filter(Boolean) as Worker[]

			if (alive.length === 0) {
				process.exit(0)
			}
			let remaining = alive.length

			for (const worker of alive) {
				worker.once("exit", () => {
					remaining--

					if (remaining === 0) {
						process.exit(0)
					}
				})
				worker.process.kill(signal)
			}
			setTimeout(() => process.exit(0), 10_000).unref()
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

const ChildThread: CommandComponent<typeof ServerConfigSchema> = ({ options: { port, host } }) => {
	useEffect(() => {
		let handle: ServerHandle | undefined

		void (async () => {
			const { engine, preflight } = await createServeEngine()

			if (!preflight.ok) {
				console.error(preflight.message)
				process.exit(1)
			}

			// 2 MiB body cap (accommodates a full /v1/batch up to MAILWOMAN_BATCH_MAX addresses) is
			// createMailwomanAPI's own default — carried from the express server's `express.json({ limit: "2mb" })`.
			const app = createMailwomanAPI(engine, { batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX) })

			handle = serveNode({
				fetch: app.fetch,
				port,
				hostname: host,
				onListen: () => cluster.worker?.send("HTTP server ready"),
			})

			// Duplicate signal deliveries (group signal + primary forward) must be no-ops — the drain runs once.
			let draining = false

			const shutdown = () => {
				if (draining) return
				draining = true

				console.error(`[serve] worker ${process.pid} draining`)
				void handle?.close().finally(() => process.exit(0))
			}

			process.on("SIGINT", shutdown)
			process.on("SIGTERM", shutdown)
		})()

		return () => void handle?.close()
	}, [host, port])

	return null
}

const ServerConfigSchema = zod.object({
	port: zod.number().optional().default(3000).describe("The port to listen on"),
	host: zod.string().optional().default("0.0.0.0").describe("The network interface to bind to"),
	cpus: zod.number().optional().describe("The number of CPUs to use"),
})

export const options = ServerConfigSchema

const ParseCommand = cluster.isPrimary ? ClusterManager : ChildThread

export default ParseCommand
