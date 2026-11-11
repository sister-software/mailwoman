/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/reload` across the `serve` cluster.
 *
 *   The operating system hands a request to one worker, and each worker holds its own geocode session. The worker that
 *   receives a reload asks the primary, the primary has every live worker reload its own session, and the requesting
 *   worker answers once all of them have. A reload therefore moves every worker to the new data generation.
 */

import cluster, { type Worker } from "node:cluster"

import type { ReloadResponse } from "@mailwoman/api/operations/reload-data"

type ReloadMessage =
	| { type: "mailwoman:reload-request"; id: string }
	| { type: "mailwoman:reload-local"; id: string }
	| { type: "mailwoman:reload-done"; id: string; error: string | null }
	| { type: "mailwoman:reload-result"; id: string; errors: string[] }

function isReloadMessage(message: unknown): message is ReloadMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		typeof (message as { type?: unknown }).type === "string" &&
		(message as { type: string }).type.startsWith("mailwoman:reload-")
	)
}

/**
 * Relays reload requests in the primary: each request reaches every live worker,
 * and the requester hears back once each has answered or exited.
 */
export function relayClusterReloads(): void {
	const pending = new Map<string, { requester: Worker; waiting: Set<number>; errors: string[] }>()

	const settle = (id: string): void => {
		const entry = pending.get(id)

		if (!entry || entry.waiting.size) return

		pending.delete(id)

		if (!entry.requester.isDead()) {
			entry.requester.send({ type: "mailwoman:reload-result", id, errors: entry.errors } satisfies ReloadMessage)
		}
	}

	cluster.on("message", (worker, message: unknown) => {
		if (!isReloadMessage(message)) return

		if (message.type === "mailwoman:reload-request") {
			const alive = Object.values(cluster.workers ?? {}).filter((entry) => entry && !entry.isDead()) as Worker[]

			pending.set(message.id, { requester: worker, waiting: new Set(alive.map((entry) => entry.id)), errors: [] })

			for (const entry of alive) {
				entry.send({ type: "mailwoman:reload-local", id: message.id } satisfies ReloadMessage)
			}

			return
		}

		if (message.type === "mailwoman:reload-done") {
			const entry = pending.get(message.id)

			if (!entry) return

			entry.waiting.delete(worker.id)

			if (message.error) {
				entry.errors.push(`worker ${worker.process.pid}: ${message.error}`)
			}

			settle(message.id)
		}
	})

	// A worker that exits mid-reload has no session left to move, so the reload stops waiting for it.
	cluster.on("exit", (worker) => {
		for (const [id, entry] of pending) {
			if (entry.waiting.delete(worker.id)) {
				settle(id)
			}
		}
	})
}

/**
 * The reload a worker's engine exposes: it asks the primary to reload every worker
 * and answers with this worker's result once all have reloaded.
 *
 * It also answers the primary's reload broadcasts by running `localReload`.
 *
 * @throws When any worker's reload failed, naming each worker and its error.
 */
export function clusterReload(localReload: () => Promise<ReloadResponse>): () => Promise<ReloadResponse> {
	const localResults = new Map<string, Promise<ReloadResponse>>()
	const waiting = new Map<string, PromiseWithResolvers<string[]>>()

	process.on("message", (message: unknown) => {
		if (!isReloadMessage(message)) return

		if (message.type === "mailwoman:reload-local") {
			const result = localReload()

			// Only the requesting worker reads its own result back.
			if (waiting.has(message.id)) {
				localResults.set(message.id, result)
			}

			void result.then(
				() => process.send?.({ type: "mailwoman:reload-done", id: message.id, error: null } satisfies ReloadMessage),
				(error: unknown) =>
					process.send?.({
						type: "mailwoman:reload-done",
						id: message.id,
						error: error instanceof Error ? error.message : String(error),
					} satisfies ReloadMessage)
			)

			return
		}

		if (message.type === "mailwoman:reload-result") {
			waiting.get(message.id)?.resolve(message.errors)
			waiting.delete(message.id)
		}
	})

	return async () => {
		const id = crypto.randomUUID()
		const result = Promise.withResolvers<string[]>()

		waiting.set(id, result)
		process.send?.({ type: "mailwoman:reload-request", id } satisfies ReloadMessage)

		const errors = await result.promise
		const local = localResults.get(id)

		localResults.delete(id)

		if (errors.length || !local) {
			throw new Error(`reload failed: ${errors.join("; ") || "this worker received no reload"}`)
		}

		return local
	}
}
