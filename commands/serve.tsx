/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner, StatusMessage } from "@inkjs/ui"
import { repoRootPathBuilder } from "@mailwoman/core/utils"
import express from "express"
import { Box, Text } from "ink"
import cluster, { Worker } from "node:cluster"
import { availableParallelism } from "node:os"
import * as process from "node:process"
import { useEffect, useState } from "react"
import zod from "zod"
import { CommandComponent } from "../sdk/cli.js"
import { AddressRouter } from "../server/index.js"

const ClusterManager: CommandComponent<typeof ServerConfigSchema> = ({
	options: { cpus = availableParallelism() },
}) => {
	const [workers, setWorkers] = useState<Worker[]>()

	useEffect(() => {
		setWorkers(Array.from({ length: cpus }, () => cluster.fork()))

		cluster.on("exit", (worker, code, signal) => {
			console.log(`[${signal}] (${code}) Worker ${worker.process.pid} exited`)
		})
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
			Unknown status "{status}" ({worker.process.pid})
		</StatusMessage>
	)
}

const ChildThread: CommandComponent<typeof ServerConfigSchema> = ({ options: { port, host } }) => {
	useEffect(() => {
		const app = express()

		app.use(express.json())
		app.use(AddressRouter)
		app.use("/admin/wof")

		const staticPath = repoRootPathBuilder("server", "static").toString()

		console.log("Serving static files from", staticPath)
		app.use(express.static(staticPath))

		app.listen(port, host, () => {
			cluster.worker?.send("HTTP server ready")
		})
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
