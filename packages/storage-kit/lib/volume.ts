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
 *   btrfs property rather than through `chattr +C` — the property leaves copy-on-write and checksums intact, and
 *   `+C` would drop both.
 *
 *   One entry rather than a list of every directory that happens to hold a database. The property propagates to
 *   children created after it is set, at any depth, so a database written into `db/` next year is uncompressed
 *   without anyone remembering to extend a list. The flat alternative was already wrong when it was written: it
 *   named eight directories and missed `address-points` and `interpolation`, which hold 54 and 52 databases.
 */

import { z } from "zod"

import { DEFAULT_MOUNT_OPTIONS } from "#fstab"
import { commaList } from "#inputs"

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
	label: z.string().default("mw").describe("The btrfs filesystem label."),
	"mount-point": z.string().default("/mnt/mw").describe("Where the volume mounts."),
	options: commaList(DEFAULT_MOUNT_OPTIONS).describe("Mount options written to /etc/fstab."),
	uncompressed: commaList(["db"]).describe(
		"Subtrees, relative to the mount point, that opt out of compression because they hold SQLite."
	),
	owner: z.string().optional().describe("The user that should own the mount point. Defaults to the sudo invoker."),
})

export type VolumeSpec = z.infer<typeof volumeSpec>
