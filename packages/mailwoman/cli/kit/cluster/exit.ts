// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `serve` primary's decision after one of its workers exits.
 */

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
}

/**
 * The primary's exit after a worker exits, or `null` while it keeps running.
 *
 * The primary forks no replacement worker.
 * A cluster with no workers left therefore exits nonzero, so a supervisor sees
 * the failure and restarts the service.
 */
export function primaryExitAfterWorkerExit(state: ClusterExitState): { code: number; reason: string } | null {
	if (state.liveWorkers > 0 || state.shuttingDown) return null

	return state.anyListened
		? { code: 1, reason: "every worker exited after the cluster listened" }
		: { code: 1, reason: "every worker exited before any listened" }
}
