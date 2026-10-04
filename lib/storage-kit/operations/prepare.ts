/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `storage.prepare` partitions and formats the data-root volume.
 *   It mounts the volume and sets compression properties. It verifies its work before returning.
 *
 *   This operation can erase a device. Before writing, guards verify the operator's serial and transport claims.
 *   They also confirm that the device is unmounted and does not back the root filesystem. The guards list every
 *   failure reason so the operator can correct all invocation problems at once.
 *
 *   `--dry-run` runs the guards and prints the steps. Its verdict matches `storage.plan`.
 */

import { readFile, writeFile } from "node:fs/promises"

import { z } from "zod"
import { $ } from "zx"

import { claimFailures, inspectDevice, rootDeviceName } from "#storage-kit/device"
import { enableUnmap, inspectDiscard } from "#storage-kit/discard"
import { spliceFstab } from "#storage-kit/fstab"
import { assertRoot, defineOperation, StorageEffect } from "#storage-kit/operation"
import { volumeSpec } from "#storage-kit/volume"

const prepareOutput = z.object({
	device: z.string(),
	partition: z.string(),
	uuid: z.string(),
	mountPoint: z.string(),
	dryRun: z.boolean(),
	steps: z.array(z.string()),
})

/**
 * Run one privileged step, failing loudly with the command's own stderr.
 */
async function step(
	context: { log: (line: string) => void },
	label: string,
	run: () => Promise<{ exitCode: number | null; stderr: string }>
): Promise<void> {
	context.log(`  ${label}`)

	const result = await run()

	if (result.exitCode !== 0) {
		throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
	}
}

/**
 * `storage.prepare` — erase a device, bring it up as the data-root volume,
 * then assert every property it set.
 */
export const prepareOperation = defineOperation({
	id: "storage.prepare",
	description:
		"Partition, format, and mount a device as the data-root volume, then check every property it set. Destructive: the operator states the serial it must match.",
	effect: StorageEffect.HostWrite,
	inputSchema: volumeSpec.strict(),
	outputSchema: prepareOutput,
	async run(input, context) {
		const device = await inspectDevice(input.device)
		const blockers = [...claimFailures(device, input)]
		const rootName = await rootDeviceName()

		if (rootName && device.name === rootName) {
			blockers.push(`${input.device} backs the root filesystem`)
		}

		if (blockers.length) {
			throw new Error(`${input.device} failed its guards:\n${blockers.map((reason) => `  - ${reason}`).join("\n")}`)
		}

		const partition = `${input.device}1`
		const steps: string[] = []

		if (context.dryRun) {
			return { device: input.device, partition, uuid: "", mountPoint: input["mount-point"], dryRun: true, steps }
		}

		assertRoot(context, "storage.prepare")

		context.log(`preparing ${input.device} (${device.model} ${device.size}, serial ${device.serial})`)

		// TRIM runs before mkfs.
		// A drive filled by another filesystem has no free erase blocks.
		// The resulting read-modify-write collapse resembles hardware failure.
		const discard = await inspectDiscard(input.device)

		if (!discard.maxBytes && discard.unmapSupported && (await enableUnmap(discard))) {
			context.log(`  provisioning_mode -> unmap (kernel had discard disabled despite LBPU=1)`)
			steps.push("provisioning-mode")
		}

		const refreshed = await inspectDiscard(input.device)

		if (refreshed.maxBytes) {
			context.log(`  discarding the whole device`)
			await step(context, "blkdiscard", () => $({ nothrow: true, quiet: true })`blkdiscard -f ${input.device}`)
			steps.push("discard")
		} else {
			context.log(`  WARNING: this device exposes no discard support — expect degraded write throughput`)
		}

		await step(context, `wipefs ${input.device}`, () => $({ nothrow: true, quiet: true })`wipefs --all ${input.device}`)
		steps.push("wipefs")

		await step(
			context,
			`zap partition table`,
			() => $({ nothrow: true, quiet: true })`sgdisk --zap-all ${input.device}`
		)

		steps.push("zap")

		await step(
			context,
			`create partition`,
			() =>
				$({
					nothrow: true,
					quiet: true,
				})`sgdisk --new=1:0:0 --typecode=1:8300 --change-name=1:${input.label} ${input.device}`
		)

		steps.push("partition")

		await $({ nothrow: true, quiet: true })`partprobe ${input.device}`
		await $({ nothrow: true, quiet: true })`udevadm settle`

		await step(
			context,
			`mkfs.btrfs ${partition}`,
			() => $({ nothrow: true, quiet: true })`mkfs.btrfs --label ${input.label} --metadata dup --force ${partition}`
		)

		steps.push("mkfs")

		const uuidProbe = await $({ nothrow: true, quiet: true })`blkid --match-tag UUID --output value ${partition}`
		const uuid = uuidProbe.stdout.trim()

		if (!uuid) throw new Error(`could not read a UUID from ${partition}`)

		await step(
			context,
			`mkdir ${input["mount-point"]}`,
			() => $({ nothrow: true, quiet: true })`mkdir -p ${input["mount-point"]}`
		)

		const fstab = await readFile("/etc/fstab", "utf8")

		await writeFile("/etc/fstab.mwops.bak", fstab, "utf8")

		await writeFile(
			"/etc/fstab",
			spliceFstab(fstab, { uuid, mountPoint: input["mount-point"], options: input.options }),
			"utf8"
		)

		steps.push("fstab")
		context.log(`  fstab updated (previous saved as /etc/fstab.mwops.bak)`)

		await $({ nothrow: true, quiet: true })`systemctl daemon-reload`

		await step(
			context,
			`mount ${input["mount-point"]}`,
			() => $({ nothrow: true, quiet: true })`mount ${input["mount-point"]}`
		)

		steps.push("mount")

		if (input.owner) {
			await step(
				context,
				`chown ${input.owner}`,
				() => $({ nothrow: true, quiet: true })`chown ${input.owner}:${input.owner} ${input["mount-point"]}`
			)

			steps.push("chown")
		}

		for (const subtree of input.uncompressed) {
			const path = `${input["mount-point"]}/${subtree}`

			await $({ nothrow: true, quiet: true })`mkdir -p ${path}`

			await step(
				context,
				`compression=none on ${subtree}`,
				() => $({ nothrow: true, quiet: true })`btrfs property set ${path} compression none`
			)

			if (input.owner) {
				await $({ nothrow: true, quiet: true })`chown ${input.owner}:${input.owner} ${path}`
			}
		}

		steps.push("compression-properties")

		await $({ nothrow: true, quiet: true })`systemctl enable --now fstrim.timer`
		steps.push("fstrim-timer")

		return { device: input.device, partition, uuid, mountPoint: input["mount-point"], dryRun: false, steps }
	},
	formatOutput(output) {
		if (output.dryRun) return `dry run — ${output.device} passes every guard, nothing written`

		return `${output.device} → ${output.mountPoint} (UUID=${output.uuid}); ran: ${output.steps.join(", ")}`
	},
})
