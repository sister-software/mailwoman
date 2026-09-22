/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `storage.status` — capacity and the compression ratio the volume is actually achieving.
 *
 *   The ratio is the number worth watching: it is what decides whether a 2 TB drive behaves like 2 TB or like 4 TB,
 *   and it drifts as the mix of text and already-compressed artifacts changes. Reported as logical bytes over bytes
 *   btrfs has allocated, which is the same arithmetic `df` cannot do.
 */

import { z } from "zod"
import { $ } from "zx"

import { defineOperation, StorageEffect } from "#operation"
import { volumeSpec } from "#volume"

const statusOutput = z.object({
	mountPoint: z.string(),
	deviceSize: z.string(),
	used: z.string(),
	available: z.string(),
	dataUsedGiB: z.number().nullable(),
	logicalGiB: z.number().nullable(),
	ratio: z.number().nullable(),
})

/**
 * Bytes btrfs has allocated for data, parsed out of `btrfs filesystem usage --raw`.
 */
function parseDataUsed(raw: string): number | null {
	const match = /Data[^\n]*?used[=:]\s*(\d+)/i.exec(raw)

	return match?.[1] ? Number(match[1]) / 1024 ** 3 : null
}

/**
 * `storage.status` — how much of the volume is used, and the compression ratio it is achieving.
 */
export const statusOperation = defineOperation({
	id: "storage.status",
	description: "Capacity and the compression ratio the data-root volume is achieving.",
	effect: StorageEffect.Read,
	inputSchema: volumeSpec.partial({ device: true, serial: true }).strict(),
	outputSchema: statusOutput,
	async run(input, context) {
		const mountPoint = input.mountPoint

		const df = await $({ nothrow: true, quiet: true })`df --block-size=1G --output=size,used,avail ${mountPoint}`
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- `df` for one mount point is a header and one row.
		const [size = "?", used = "?", available = "?"] = (df.stdout.split("\n")[1] ?? "").trim().split(/\s+/)

		const usage = await $({ nothrow: true, quiet: true })`btrfs filesystem usage --raw ${mountPoint}`
		const dataUsedGiB = usage.exitCode === 0 ? parseDataUsed(usage.stdout) : null

		// `du --apparent-size` is the logical total; btrfs's allocated figure is what it cost.
		const logical = await $({
			nothrow: true,
			quiet: true,
		})`du --summarize --block-size=1G --apparent-size ${mountPoint}`

		const logicalGiB = logical.exitCode === 0 ? Number(logical.stdout.trim().split(/\s+/)[0]) : null

		const ratio = dataUsedGiB && logicalGiB && dataUsedGiB > 0 ? Number((logicalGiB / dataUsedGiB).toFixed(2)) : null

		context.log(ratio ? `${mountPoint}: ${ratio}x compression` : `${mountPoint}: ratio unavailable`)

		return {
			mountPoint,
			deviceSize: `${size}G`,
			used: `${used}G`,
			available: `${available}G`,
			dataUsedGiB,
			logicalGiB,
			ratio,
		}
	},
	formatOutput(output) {
		const ratio = output.ratio ? `${output.ratio}x compression` : "compression ratio unavailable"

		return `${output.mountPoint}: ${output.used} used of ${output.deviceSize}, ${output.available} free — ${ratio}`
	},
})
