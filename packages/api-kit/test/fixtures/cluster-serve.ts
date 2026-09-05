/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A cluster primary that forks one worker running `serveNode`, the shape `mailwoman serve` runs in. Node's cluster
 *   child calls `server.address()` inside its own `listening` handler, so a handle that shadows that method fails here
 *   and nowhere in an in-process test. The primary prints `LISTENING <port>` once the worker reports its bound port
 *   and exits 0; a worker that dies first makes the primary exit with the worker's code.
 */

import cluster from "node:cluster"

import { serveNode } from "@mailwoman/api-kit"

if (cluster.isPrimary) {
	const worker = cluster.fork()

	worker.on("message", (message: { port: number }) => {
		process.stdout.write(`LISTENING ${message.port}\n`)
		worker.kill()
	})

	worker.on("exit", (code, signal) => {
		process.exitCode = signal === "SIGTERM" ? 0 : (code ?? 1)
	})
} else {
	await serveNode({
		fetch: () => new Response("ok"),
		port: 0,
		hostname: "127.0.0.1",
		onListen: (info) => cluster.worker?.send({ port: info.port }),
	})
}
