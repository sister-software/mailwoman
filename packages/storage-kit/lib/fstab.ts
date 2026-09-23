/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rendering and splicing one `/etc/fstab` line.
 *
 *   Kept as string functions over string input so the interesting part — that an existing entry for the same mount
 *   point is replaced rather than duplicated — is unit-testable without a privileged sandbox or a real fstab.
 */

/**
 * The mount options the data-root volume is mounted with.
 *
 * `compress` rather than `compress-force`, and the difference is load-bearing.
 * `compress-force` overrides the per-directory `compression=none` property, so the database subtrees
 * would be compressed anyway and every 4 KiB SQLite page read would decompress a 128 KiB extent.
 *
 * Measured on a scratch volume: under `compress-force`, a file in a `compression=none`
 * directory still came back with 1600 encoded extents; under `compress` it came back with none.
 * The heuristic that `compress` applies is not a problem for this data — it skips
 * what looks already compressed, which is what the model and tile artifacts want,
 * and it compresses the corpus text correctly.
 *
 * The volume this replaces ran plain `compress=zstd:3` and achieved 2.3x.
 * `nofail` keeps a missing external drive from blocking boot, and discard is deliberately absent —
 * TRIM passthrough over USB bridges is inconsistent, so `fstrim.timer` does it on a schedule instead.
 */
export const DEFAULT_MOUNT_OPTIONS = [
	"noatime",
	"compress=zstd:6",
	"space_cache=v2",
	"nofail",
	"x-systemd.device-timeout=30",
] as const

export interface FstabEntry {
	uuid: string
	mountPoint: string
	options: readonly string[]
}

/**
 * One fstab line, mounted by UUID because a `/dev/sdX` node is assigned in discovery order.
 */
export function renderFstabEntry(entry: FstabEntry): string {
	return `UUID=${entry.uuid} ${entry.mountPoint} btrfs ${entry.options.join(",")} 0 2`
}

/**
 * `fstab` with any existing entry for this mount point replaced by the rendered one.
 *
 * Matching is on the mount point field rather than the UUID: re-preparing a drive gives
 * it a new UUID, and the stale line would otherwise accumulate and shadow the new one.
 */
export function spliceFstab(fstab: string, entry: FstabEntry): string {
	const rendered = renderFstabEntry(entry)

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- /etc/fstab is a handful of lines by definition.
	const kept = fstab.split("\n").filter((line) => {
		if (line.trim().startsWith("#")) return true

		return line.split(/\s+/)[1] !== entry.mountPoint
	})

	while (kept.length && kept.at(-1)!.trim() === "") {
		kept.pop()
	}

	return [...kept, rendered, ""].join("\n")
}
