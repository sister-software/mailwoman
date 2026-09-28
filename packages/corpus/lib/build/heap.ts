/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The heap a build needs before a resident-record adapter may run.
 */

/**
 * Adapter ids whose run holds every source record resident before yielding a row.
 *
 * Both WOF adapters build a `Map` of the whole dataset and then sort its keys,
 * so peak memory is a property of the source rather than of `limit`.
 * Measured 2026-09-26: `wof-admin` peaks at 14,020 MiB.
 * Both in one process peak at 14,883 MiB.
 */
const RESIDENT_RECORD_ADAPTERS: ReadonlySet<string> = new Set(["wof-admin", "wof-postalcode"])

/**
 * The heap a build needs before a resident-record adapter may run, in bytes.
 *
 * At Node's 4 GB default both WOF adapters abort with SIGABRT, `wof-admin` at 4,085 MB after 722 seconds.
 * The floor sits under the measured 14,883 MiB peak by enough to admit a 16 GB cap
 * and refuse the 4 GB default.
 */
export const RESIDENT_ADAPTER_HEAP_FLOOR_BYTES = 15 * 1024 * 1024 * 1024

/**
 * Refuses a build whose heap cannot hold a resident-record adapter's dataset.
 *
 * The failure this replaces is a SIGABRT twelve minutes into an eight-hour build.
 * That abort reports no cause and loses the adapter phase.
 * A startup read of the limit costs one call.
 *
 * The `corpus build` command calls this rather than `buildCorpus`, because this package's
 * own tests run `wof-admin` against a five-kilobyte fixture at the default heap.
 *
 * @throws When a resident-record adapter is configured and the heap limit is under the floor.
 */
export function assertHeapForAdapters(adapterIDs: readonly string[], heapLimitBytes: number): void {
	const resident = adapterIDs.filter((id) => RESIDENT_RECORD_ADAPTERS.has(id))

	if (!resident.length || heapLimitBytes >= RESIDENT_ADAPTER_HEAP_FLOOR_BYTES) return

	const gib = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`

	throw new Error(
		`corpus build: the heap limit is ${gib(heapLimitBytes)} and ${resident.join(", ")} ` +
			`${resident.length === 1 ? "holds" : "hold"} every source record resident. That peaked at 14,883 MiB ` +
			`on 2026-09-26. Re-run with NODE_OPTIONS="--max-old-space-size=20480", or leave ` +
			`${resident.join(", ")} out of --inputs. Under ${gib(RESIDENT_ADAPTER_HEAP_FLOOR_BYTES)} the run aborts ` +
			`with SIGABRT partway through the adapter phase.`
	)
}
