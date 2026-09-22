/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The parts of storage preparation that decide whether a disk gets erased, exercised without a disk.
 */

import {
	assertRoot,
	claimFailures,
	findStorageOperation,
	renderFstabEntry,
	spliceFstab,
	StorageEffect,
	storageOperations,
	type BlockDevice,
} from "@mailwoman/storage-kit"
import { describe, expect, it } from "vitest"

const T7: BlockDevice = {
	name: "sda",
	size: "1.8T",
	model: "PSSD T7 Shield",
	serial: "H20240CW0JNPN6S",
	transport: "usb",
	filesystems: ["vfat", "apfs"],
	mountpoints: [],
}

describe("claimFailures", () => {
	it("passes a device that matches the claim", () => {
		expect(claimFailures(T7, { serial: "H20240CW0JNPN6S", transport: "usb", model: "T7 Shield" })).toEqual([])
	})

	it("refuses a serial mismatch — the node name alone never identifies a disk", () => {
		expect(claimFailures(T7, { serial: "SOMETHINGELSE" })).toEqual([
			"serial is H20240CW0JNPN6S, expected SOMETHINGELSE",
		])
	})

	it("refuses a mounted device", () => {
		const mounted = { ...T7, mountpoints: ["/mnt/coldstore"] }

		expect(claimFailures(mounted, { serial: T7.serial })).toEqual([
			"still mounted at /mnt/coldstore — unmount before preparing",
		])
	})

	it("reports every failure rather than only the first", () => {
		expect(claimFailures({ ...T7, transport: "sata" }, { serial: "OTHER", transport: "usb" })).toHaveLength(2)
	})
})

describe("spliceFstab", () => {
	const entry = { uuid: "1234", mountPoint: "/mnt/coldstore", options: ["noatime", "nofail"] }

	it("appends when no entry exists", () => {
		expect(spliceFstab("UUID=aaa / ext4 defaults 0 1\n", entry)).toBe(
			"UUID=aaa / ext4 defaults 0 1\nUUID=1234 /mnt/coldstore btrfs noatime,nofail 0 2\n"
		)
	})

	it("replaces a prior entry for the same mount point rather than duplicating it", () => {
		const before = "UUID=aaa / ext4 defaults 0 1\nUUID=old /mnt/coldstore btrfs noatime 0 2\n"
		const after = spliceFstab(before, entry)

		expect(after.match(/\/mnt\/coldstore/g)).toHaveLength(1)
		expect(after).toContain("UUID=1234")
		expect(after).not.toContain("UUID=old")
	})

	it("keeps comments", () => {
		expect(spliceFstab("# managed\nUUID=aaa / ext4 defaults 0 1\n", entry)).toContain("# managed")
	})
})

describe("renderFstabEntry", () => {
	it("mounts by UUID, because /dev/sdX is assigned in discovery order", () => {
		expect(renderFstabEntry({ uuid: "abc", mountPoint: "/mnt/x", options: ["noatime"] })).toBe(
			"UUID=abc /mnt/x btrfs noatime 0 2"
		)
	})
})

describe("assertRoot", () => {
	it("throws without root", () => {
		expect(() => assertRoot({ dryRun: false, root: false, log: () => {} }, "storage.prepare")).toThrow(/needs root/)
	})

	it("returns with root", () => {
		expect(() => assertRoot({ dryRun: false, root: true, log: () => {} }, "storage.prepare")).not.toThrow()
	})
})

describe("registry", () => {
	it("resolves an operation by bare name and by dotted id", () => {
		expect(findStorageOperation("prepare")?.id).toBe("storage.prepare")
		expect(findStorageOperation("storage.prepare")?.id).toBe("storage.prepare")
	})

	it("declares exactly one host write — everything else reads", () => {
		const writes = storageOperations.filter((operation) => operation.effect === StorageEffect.HostWrite)

		expect(writes.map((operation) => operation.id)).toEqual(["storage.prepare"])
	})
})
