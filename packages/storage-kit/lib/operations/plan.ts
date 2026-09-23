/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `storage.plan` — what `storage.prepare` would do to this device, and every reason it would refuse.
 *
 *   Read-only and unprivileged on purpose: the operator should be able to see the guard verdict without first handing
 *   the process root.
 */

import { z } from "zod"

import { claimFailures, inspectDevice, rootDeviceName } from "#device"
import { renderFstabEntry } from "#fstab"
import { defineOperation, StorageEffect } from "#operation"
import { volumeSpec } from "#volume"

const planOutput = z.object({
	device: z.object({
		name: z.string(),
		size: z.string(),
		model: z.string(),
		serial: z.string(),
		transport: z.string(),
		filesystems: z.array(z.string()),
		mountpoints: z.array(z.string()),
	}),
	blockers: z.array(z.string()),
	steps: z.array(z.string()),
})

/**
 * `storage.plan` — the steps `storage.prepare` would run, and every guard that would stop it.
 */
export const planOperation = defineOperation({
	id: "storage.plan",
	description: "Show what `storage prepare` would do to a device, and every guard that would stop it.",
	effect: StorageEffect.Read,
	inputSchema: volumeSpec.strict(),
	outputSchema: planOutput,
	async run(input, context) {
		const device = await inspectDevice(input.device)
		const blockers = [...claimFailures(device, input)]

		const rootName = await rootDeviceName()

		if (rootName && device.name === rootName) {
			blockers.push(`${input.device} backs the root filesystem`)
		}

		const partition = `${input.device}1`

		const steps = [
			`wipefs --all ${input.device}`,
			`sgdisk --zap-all ${input.device}`,
			`sgdisk --new=1:0:0 --typecode=1:8300 --change-name=1:${input.label} ${input.device}`,
			`mkfs.btrfs --label ${input.label} --metadata dup ${partition}`,
			`mount ${partition} at ${input["mount-point"]}`,
			`fstab: ${renderFstabEntry({ uuid: "<new>", mountPoint: input["mount-point"], options: input.options })}`,
			...input.uncompressed.map((subtree) => `btrfs property set ${input["mount-point"]}/${subtree} compression none`),
			"systemctl enable --now fstrim.timer",
		]

		context.log(
			blockers.length
				? `${input.device} fails ${blockers.length} guard(s)`
				: `${input.device} passes every guard — ${steps.length} steps`
		)

		return {
			device: { ...device, filesystems: [...device.filesystems], mountpoints: [...device.mountpoints] },
			blockers,
			steps,
		}
	},
	formatOutput(output) {
		const header = `${output.device.name}  ${output.device.size}  ${output.device.model || "(no model)"}  serial=${output.device.serial || "(none)"}`

		const blockers = output.blockers.length
			? ["", "BLOCKED:", ...output.blockers.map((reason) => `  ✗ ${reason}`)]
			: ["", "✓ every guard passes"]

		const steps = ["", "Would run:", ...output.steps.map((step, index) => `  ${index + 1}. ${step}`)]

		return [header, ...blockers, ...steps].join("\n")
	},
})
