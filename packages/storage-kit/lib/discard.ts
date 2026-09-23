/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Making TRIM work before the filesystem is written, which on a USB-attached SSD is not a given.
 *
 *   The Samsung T7 Shield reports `LBPU=1` (the UNMAP command is supported) and `LBPWS=0` (WRITE SAME with the unmap
 *   bit is not). The kernel's default `provisioning_mode` of `full` wants the latter, so it publishes a discard limit
 *   of zero and `blkdiscard` silently does nothing. A drive that arrives full of someone else's filesystem then has
 *   no free erase blocks, and every write becomes read-modify-write.
 *
 *   Measured on this drive: 2.1 MB/s with 636 ms write latency at the raw block device, against 755 MB/s once the
 *   mode was corrected and the device trimmed. That symptom reads as a failing disk, so `prepare` checks both the
 *   kernel's limit and the device's own claim before it formats anything.
 */

import { $ } from "zx"

export interface DiscardSupport {
	/**
	 * The kernel's published maximum discard bytes.
	 * Zero means `blkdiscard` will do nothing.
	 */
	maxBytes: number
	/**
	 * Whether the device itself reports the UNMAP command, regardless of what the kernel has enabled.
	 */
	unmapSupported: boolean
	/**
	 * The `scsi_disk` provisioning mode, which USB and SCSI devices carry and NVMe leaves absent.
	 */
	provisioningMode?: string
	/**
	 * Where that mode is written, when it can be corrected.
	 */
	provisioningModePath?: string
}

/**
 * The bare device name for a path like `/dev/sda`.
 */
function deviceName(device: string): string {
	return device.replace(/^\/dev\//, "")
}

/**
 * What the kernel and the device each believe about discard.
 */
export async function inspectDiscard(device: string): Promise<DiscardSupport> {
	const name = deviceName(device)

	const max = await $({ nothrow: true, quiet: true })`cat /sys/block/${name}/queue/discard_max_bytes`
	const maxBytes = max.exitCode === 0 ? Number(max.stdout.trim()) || 0 : 0

	// `sg_vpd` reads the device's own claim, which is what makes a zero kernel limit correctable.
	const vpd = await $({ nothrow: true, quiet: true })`sg_vpd -p lbpv ${device}`
	const unmapSupported = vpd.exitCode === 0 && /LBPU\)?:\s*1/.test(vpd.stdout)

	const modePath = await $({
		nothrow: true,
		quiet: true,
	})`sh -c ${`ls /sys/block/${name}/device/scsi_disk/*/provisioning_mode 2>/dev/null | head -1`}`

	const provisioningModePath = modePath.exitCode === 0 ? modePath.stdout.trim() || undefined : undefined

	let provisioningMode: string | undefined

	if (provisioningModePath) {
		const mode = await $({ nothrow: true, quiet: true })`cat ${provisioningModePath}`
		provisioningMode = mode.exitCode === 0 ? mode.stdout.trim() : undefined
	}

	return { maxBytes, unmapSupported, provisioningMode, provisioningModePath }
}

/**
 * Switch a device whose bridge supports UNMAP but whose kernel mode disables discard.
 *
 * Returns whether anything changed.
 * The write does not survive a replug, so a caller that wants it permanent installs a udev rule as well.
 */
export async function enableUnmap(support: DiscardSupport): Promise<boolean> {
	if (!support.provisioningModePath) return false

	if (support.maxBytes > 0) return false

	if (!support.unmapSupported) return false

	const written = await $({
		nothrow: true,
		quiet: true,
	})`sh -c ${`echo unmap > ${support.provisioningModePath}`}`

	return written.exitCode === 0
}
