/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { threadId, workerData } from "node:worker_threads"

/**
 * Returns the `threadId` of the thread running this module: 0 on the main thread,
 * and a positive integer in a worker.
 */
export function workerThreadID(): number {
	return threadId
}

/**
 * The `userData` a spliterator `parallelMapWorkers` coordinator passed this worker thread.
 *
 * spliterator forwards a coordinator's `workerData` option to every worker as `workerData.userData`.
 * The value is structured-cloned, so the type parameter states what the
 * coordinator sent rather than checking it.
 *
 * @throws When this module runs outside a worker thread, or the coordinator passed no `userData`.
 */
export function workerUserData<T>(): T {
	const userData = (workerData as { userData?: unknown } | null)?.userData

	if (userData == null) {
		throw new Error(
			"this module reads its settings from workerData.userData, which only a parallelMapWorkers worker thread " +
				"started with a `workerData` option receives"
		)
	}

	return userData as T
}
