/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import express from "express"
import { AddressParser } from "mailwoman"
import { repoRootPathBuilder } from "mailwoman/sdk/repo"
import cluster from "node:cluster"
import { cpus } from "node:os"
import { parseRouteHandler } from "./routes/parse.js"

/**
 * Start the Pelias Parser HTTP server.
 */
export function startPeliasParserServer() {
	// select the amount of cpus we will use
	const cpuInfo = cpus()
	const envCpus = process.env.CPUS ? parseInt(process.env.CPUS, 10) : cpuInfo.length
	const cpuCount = Math.min(Math.max(envCpus, 1), cpuInfo.length)

	// optionally override port/host using env var
	const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000
	const HOST = process.env.HOST || "0.0.0.0"
	const app = express()

	// init placeholder and store it on $app
	console.error("parser loading")
	app.locals.parser = {
		address: new AddressParser(),
	}

	// generic http headers
	app.use((_req, res, next) => {
		res.header("Charset", "utf8")
		// production setting
		// res.header('Cache-Control', 'public, max-age=120')
		next()
	})

	// routes
	app.get("/parser/parse", parseRouteHandler)
	app.use("/demo", express.static(repoRootPathBuilder("server/static").toString()))
	app.use("/", (_req, res) => {
		res.redirect("/demo")
	})

	// start multi-threaded server
	if (cpuCount > 1) {
		if (cluster.isPrimary) {
			console.error("[master] using %d cpus", cpuCount)

			// worker exit event
			cluster.on("exit", (worker) => {
				console.error("[master] worker died", worker.process.pid)
			})

			// worker fork event
			cluster.on("fork", (worker) => {
				console.error("[master] worker forked", worker.process.pid)
			})

			// handle SIGTERM (required for fast docker restarts)
			process.on("SIGTERM", () => {
				console.error("[master] closing app")

				if (!cluster.workers) return

				for (const worker of Object.values(cluster.workers)) {
					if (!worker) continue

					worker.send("graceful-shutdown")
				}
			})

			for (let i = 0; i < cpuCount; i++) {
				cluster.fork()
			}
		} else {
			const server = app.listen(PORT, HOST, () => {
				console.error("[worker %d] listening on %s:%s", process.pid, HOST || "0.0.0.0", PORT)
			})

			process.on("message", (msg) => {
				// handle SIGTERM (required for fast docker restarts)
				if (msg === "graceful-shutdown") {
					console.error("[worker %d] closing server", process.pid)

					server.close(() => cluster.worker?.disconnect())
				}
			})
		}

		// start single-threaded server
	} else {
		console.error("[master] using %d cpus", cpuCount)

		const server = app.listen(PORT, HOST, () => {
			console.log("[master] listening on %s:%s", HOST || "0.0.0.0", PORT)
			// handle SIGTERM (required for fast docker restarts)

			process.on("SIGTERM", () => {
				console.error("[master] closing app")
				server.close()
			})
		})
	}

	return app
}
