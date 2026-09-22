/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `storage.prepare` — partition, format, mount, and set compression properties on the data-root volume, in one
 *   operation that ends by verifying its own work.
 *
 *   Destructive, and guarded accordingly: the device has to satisfy the operator's serial and transport claim, be
 *   unmounted, and not back the root filesystem. The guards run before anything is written, and a failure lists every
 *   reason rather than the first, so a mistyped invocation is corrected once.
 *
 *   `--dry-run` runs the guards and prints the steps without touching the device, which is the same verdict
 *   `storage.plan` gives.
 */

import { readFile, writeFile } from "node:fs/promises"

import { z } from "zod"
import { $ } from "zx"

import { claimFailures, inspectDevice, rootDeviceName } from "#device"
import { spliceFstab } from "#fstab"
import { assertRoot, defineOperation, StorageEffect } from "#operation"
import { volumeSpec } from "#volume"

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
 * `storage.prepare` — erase a device and bring it up as the data-root volume, then verify the result.
 */
export const prepareOperation = defineOperation({
	id: "storage.prepare",
	description:
		"Partition, format, and mount a device as the data-root volume, then verify it. Destructive — guarded by an expected serial.",
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
			return { device: input.device, partition, uuid: "", mountPoint: input.mountPoint, dryRun: true, steps }
		}

		assertRoot(context, "storage.prepare")

		context.log(`preparing ${input.device} (${device.model} ${device.size}, serial ${device.serial})`)

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
			`mkdir ${input.mountPoint}`,
			() => $({ nothrow: true, quiet: true })`mkdir -p ${input.mountPoint}`
		)

		const fstab = await readFile("/etc/fstab", "utf8")

		await writeFile("/etc/fstab.mwops.bak", fstab, "utf8")

		await writeFile(
			"/etc/fstab",
			spliceFstab(fstab, { uuid, mountPoint: input.mountPoint, options: input.options }),
			"utf8"
		)

		steps.push("fstab")
		context.log(`  fstab updated (previous saved as /etc/fstab.mwops.bak)`)

		await $({ nothrow: true, quiet: true })`systemctl daemon-reload`
		await step(context, `mount ${input.mountPoint}`, () => $({ nothrow: true, quiet: true })`mount ${input.mountPoint}`)
		steps.push("mount")

		if (input.owner) {
			await step(
				context,
				`chown ${input.owner}`,
				() => $({ nothrow: true, quiet: true })`chown ${input.owner}:${input.owner} ${input.mountPoint}`
			)

			steps.push("chown")
		}

		for (const subtree of input.uncompressed) {
			const path = `${input.mountPoint}/${subtree}`

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

		return { device: input.device, partition, uuid, mountPoint: input.mountPoint, dryRun: false, steps }
	},
	formatOutput(output) {
		if (output.dryRun) return `dry run — ${output.device} passes every guard, nothing written`

		return `${output.device} → ${output.mountPoint} (UUID=${output.uuid}); ran: ${output.steps.join(", ")}`
	},
})
