/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Block-device inspection and the guards that stand between `storage prepare` and someone's root filesystem.
 *
 *   Every guard is expressed as a claim the operator states up front — the serial they expect, the transport they
 *   expect — and the device has to match all of them. A device that has drifted (re-enumerated as a different node,
 *   swapped for another enclosure) fails the claim rather than getting formatted, because `/dev/sdX` names are
 *   assigned in discovery order and are not stable across reboots.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { $ } from "zx"

export interface BlockDevice {
	name: string
	size: string
	model: string
	serial: string
	transport: string
	filesystems: readonly string[]
	mountpoints: readonly string[]
}

/**
 * Everything `lsblk` knows about one device and its partitions.
 */
export async function inspectDevice(device: string): Promise<BlockDevice> {
	const probe = await $({
		nothrow: true,
		quiet: true,
	})`lsblk --json --output NAME,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINT ${device}`

	if (probe.exitCode !== 0) {
		throw new Error(`${device} is not a block device this machine can see`)
	}

	const parsed = parseJSONStrict<{
		blockdevices?: Array<{
			name?: string
			size?: string
			model?: string
			serial?: string
			tran?: string
			fstype?: string | null
			mountpoint?: string | null
			children?: Array<{ fstype?: string | null; mountpoint?: string | null }>
		}>
	}>(probe.stdout)

	const top = parsed.blockdevices?.[0]

	if (!top) throw new Error(`lsblk reported nothing for ${device}`)

	const children = top.children ?? []

	return {
		name: top.name ?? device,
		size: top.size ?? "unknown",
		model: (top.model ?? "").trim(),
		serial: (top.serial ?? "").trim(),
		transport: (top.tran ?? "").trim(),
		filesystems: [top.fstype, ...children.map((child) => child.fstype)].filter((value): value is string =>
			Boolean(value)
		),
		mountpoints: [top.mountpoint, ...children.map((child) => child.mountpoint)].filter((value): value is string =>
			Boolean(value)
		),
	}
}

export interface DeviceClaim {
	/**
	 * The serial the operator expects, from `lsblk -dno SERIAL`.
	 *
	 * This is the guard that actually distinguishes one disk from another — the `/dev/sdX` node does not.
	 */
	serial: string
	/**
	 * The transport the operator expects.
	 * `usb` for an external enclosure.
	 */
	transport?: string
	/**
	 * A substring of the model string, when the operator wants the extra assurance.
	 */
	model?: string
}

/**
 * Every reason a device fails the operator's claim, rather than only the first.
 *
 * An operator who mistyped both the serial and the transport should see both.
 */
export function claimFailures(device: BlockDevice, claim: DeviceClaim): readonly string[] {
	const failures: string[] = []

	if (device.serial !== claim.serial) {
		failures.push(`serial is ${device.serial || "(none)"}, expected ${claim.serial}`)
	}

	if (claim.transport && device.transport !== claim.transport) {
		failures.push(`transport is ${device.transport || "(none)"}, expected ${claim.transport}`)
	}

	if (claim.model && !device.model.includes(claim.model)) {
		failures.push(`model is ${device.model || "(none)"}, expected it to contain ${claim.model}`)
	}

	if (device.mountpoints.length) {
		failures.push(`still mounted at ${device.mountpoints.join(", ")} — unmount before preparing`)
	}

	return failures
}

/**
 * The device backing `/`, so a claim can never be satisfied by the boot disk.
 *
 * Returned as a bare device name (`nvme0n1`) because that is what `lsblk --output NAME` reports.
 */
export async function rootDeviceName(): Promise<string | undefined> {
	const probe = await $({ nothrow: true, quiet: true })`findmnt --noheadings --output SOURCE --target /`

	if (probe.exitCode !== 0) return undefined

	const source = probe.stdout.trim()

	if (!source.startsWith("/dev/")) return undefined

	const resolved = await $({ nothrow: true, quiet: true })`lsblk --noheadings --output PKNAME ${source}`

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- `lsblk PKNAME` for one device is a single line.
	return resolved.exitCode === 0 ? resolved.stdout.trim().split("\n")[0]?.trim() || undefined : undefined
}
