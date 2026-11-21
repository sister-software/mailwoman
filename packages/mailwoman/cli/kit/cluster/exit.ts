// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `serve` primary's decision after one of its workers exits.
 */

/**
 * The most workers the primary forks as replacements inside {@link WORKER_RESPAWN_WINDOW_MS}.
 *
 * It is a starting value with no measurement behind it.
 */
export const WORKER_RESPAWN_LIMIT = 3

/**
 * The span over which {@link WORKER_RESPAWN_LIMIT} counts replacements.
 */
export const WORKER_RESPAWN_WINDOW_MS = 60_000

/**
 * What the primary knows when a worker exits.
 */
export interface ClusterExitState {
	/**
	 * Workers still running after this exit.
	 */
	liveWorkers: number
	/**
	 * Whether any worker has bound the port since the primary started.
	 */
	anyListened: boolean
	/**
	 * Whether the primary is forwarding a shutdown signal.
	 *
	 * The forwarding path exits on its own once the workers drain.
	 */
	shuttingDown: boolean
	/**
	 * Whether the worker that exited had bound the port.
	 *
	 * A worker that exits before it listens failed its preflight or its boot,
	 * and a replacement would fail the same way.
	 */
	workerListened: boolean
	/**
	 * The replacements the primary has forked inside the window, this exit's not included.
	 */
	recentRespawns: number
}

/**
 * What the primary does after a worker exits.
 */
export type ClusterExitAction =
	/**
	 * Fork a replacement worker.
	 */
	| { respawn: true }
	/**
	 * Exit the primary with `code`.
	 */
	| { respawn: false; code: number; reason: string }

/**
 * The primary's action after a worker exits, or `null` while it keeps running as it is.
 *
 * A worker that had been serving is replaced, so one failed worker costs its
 * in-flight requests and leaves the cluster at the same size.
 *
 * Past {@link WORKER_RESPAWN_LIMIT} replacements inside the window the primary stops replacing.
 * A cluster with zero workers left then exits nonzero, so an outside supervisor
 * sees the failure and restarts the service.
 */
export function primaryActionAfterWorkerExit(state: ClusterExitState): ClusterExitAction | null {
	if (state.shuttingDown) return null

	if (state.workerListened && state.recentRespawns < WORKER_RESPAWN_LIMIT) return { respawn: true }

	if (state.liveWorkers > 0) return null

	return state.anyListened
		? { respawn: false, code: 1, reason: "every worker exited after the cluster listened" }
		: { respawn: false, code: 1, reason: "every worker exited before any listened" }
}
