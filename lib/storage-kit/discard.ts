/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $ } from "zx"

export interface DiscardSupport {
	/**
	 * The kernel's published maximum discard bytes.
	 * Zero means `blkdiscard` will make no change.
	 */
	maxBytes: number
	/**
	 * Whether the device itself reports the UNMAP command, regardless of what the kernel has enabled.
	 */
	unmapSupported: boolean
	/**
	 * The `scsi_disk` provisioning mode, present on USB and SCSI devices and absent on NVMe devices.
	 */
	provisioningMode: string | null
	/**
	 * Where that mode is written, when it can be corrected.
	 */
	provisioningModePath: string | null
}

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

	// `sg_vpd` reads the device's own claim.
	// That lets us correct a zero kernel limit.
	const vpd = await $({ nothrow: true, quiet: true })`sg_vpd -p lbpv ${device}`
	const unmapSupported = vpd.exitCode === 0 && /LBPU\)?:\s*1/.test(vpd.stdout)

	const modePath = await $({
		nothrow: true,
		quiet: true,
	})`sh -c ${`ls /sys/block/${name}/device/scsi_disk/*/provisioning_mode 2>/dev/null | head -1`}`

	const provisioningModePath = modePath.exitCode === 0 ? modePath.stdout.trim() || null : null

	let provisioningMode: string | null = null

	if (provisioningModePath) {
		const mode = await $({ nothrow: true, quiet: true })`cat ${provisioningModePath}`
		provisioningMode = mode.exitCode === 0 ? mode.stdout.trim() : null
	}

	return { maxBytes, unmapSupported, provisioningMode, provisioningModePath }
}

/**
 * Switch a device whose bridge supports UNMAP but whose kernel mode disables discard.
 *
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
