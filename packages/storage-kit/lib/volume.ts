/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The volume spec every storage operation shares: which disk, mounted where, and which subtrees opt out of
 *   compression.
 *
 *   The uncompressed list is not a performance preference. btrfs compresses in 128 KiB extents while a SQLite page
 *   read is 4 KiB, so a random page read decompresses the whole extent. The retrieval databases are built once and
 *   then read randomly, which is precisely the access pattern that amplification punishes, so they opt out through a
 *   btrfs property rather than through `chattr +C` — the property leaves copy-on-write and checksums intact.
 */

import { z } from "zod"

import { DEFAULT_MOUNT_OPTIONS } from "#fstab"

/**
 * Which disk, mounted where, with which subtrees opting out of compression.
 *
 * Shared by every storage operation so one invocation's flags describe the same volume as the next.
 */
export const volumeSpec = z.object({
	device: z.string().describe("The block device to prepare, e.g. /dev/sda."),
	serial: z.string().describe("The serial the device must report, from `lsblk -dno SERIAL`."),
	transport: z.string().default("usb").describe("The transport the device must report."),
	model: z.string().optional().describe("A substring the device model must contain."),
	label: z.string().default("coldstore").describe("The btrfs filesystem label."),
	mountPoint: z.string().default("/mnt/coldstore").describe("Where the volume mounts."),
	options: z
		.array(z.string())
		.default([...DEFAULT_MOUNT_OPTIONS])
		.describe("Mount options written to /etc/fstab."),
	uncompressed: z
		.array(z.string())
		.default(["wof", "ban", "osm", "poi", "flood", "soil", "gauntlet", "filer"])
		.describe("Subtrees, relative to the mount point, that opt out of compression because they hold SQLite."),
	owner: z.string().optional().describe("The user that should own the mount point. Defaults to the sudo invoker."),
})

export type VolumeSpec = z.infer<typeof volumeSpec>
