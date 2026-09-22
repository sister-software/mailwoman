/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `storage.verify` — every property `storage.prepare` was supposed to establish, asserted again from scratch.
 *
 *   This is the operation that makes the preparation non-forgettable. `prepare` ends by calling it, and it re-runs
 *   standalone afterwards, so "did anyone remember to set the compression property on the database subtrees" stops
 *   being something a person has to hold in their head.
 */

import { z } from "zod"
import { $ } from "zx"

import { defineOperation, StorageEffect } from "#operation"
import { volumeSpec } from "#volume"

const check = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })

const verifyOutput = z.object({
	mountPoint: z.string(),
	checks: z.array(check),
	passed: z.number(),
	failed: z.number(),
})

/**
 * The mount options currently in effect, as reported by the kernel rather than by fstab.
 */
async function activeOptions(mountPoint: string): Promise<string | undefined> {
	const probe = await $({ nothrow: true, quiet: true })`findmnt --noheadings --output OPTIONS --target ${mountPoint}`

	return probe.exitCode === 0 ? probe.stdout.trim() : undefined
}

/**
 * `storage.verify` — assert the volume still has the properties `storage.prepare` established.
 */
export const verifyOperation = defineOperation({
	id: "storage.verify",
	description: "Assert the data-root volume is mounted with the intended options and compression properties.",
	effect: StorageEffect.Read,
	inputSchema: volumeSpec.partial({ device: true, serial: true }).strict(),
	outputSchema: verifyOutput,
	async run(input, context) {
		const mountPoint = input.mountPoint
		const checks: Array<z.infer<typeof check>> = []

		const fstype = await $({ nothrow: true, quiet: true })`findmnt --noheadings --output FSTYPE --target ${mountPoint}`
		const mounted = fstype.exitCode === 0 && fstype.stdout.trim() === "btrfs"

		checks.push({
			name: "mounted as btrfs",
			ok: mounted,
			detail: mounted ? mountPoint : `${mountPoint} is not a btrfs mount`,
		})

		const options = await activeOptions(mountPoint)

		for (const expected of input.options) {
			// `nofail` and the systemd timeout are fstab-only directives the kernel never echoes back.
			if (expected === "nofail" || expected.startsWith("x-systemd.")) continue

			const present = Boolean(options?.includes(expected))

			checks.push({ name: `mount option ${expected}`, ok: present, detail: present ? "active" : "missing" })
		}

		const fstab = await $({ nothrow: true, quiet: true })`grep -c ${mountPoint} /etc/fstab`
		const inFstab = fstab.exitCode === 0 && Number(fstab.stdout.trim()) > 0

		checks.push({
			name: "fstab entry",
			ok: inFstab,
			detail: inFstab ? "present" : `no /etc/fstab line for ${mountPoint}`,
		})

		for (const subtree of input.uncompressed) {
			const path = `${mountPoint}/${subtree}`
			const property = await $({ nothrow: true, quiet: true })`btrfs property get ${path} compression`
			const none = property.exitCode === 0 && property.stdout.includes("compression=none")

			checks.push({
				name: `${subtree} compression disabled`,
				ok: none,
				detail: none ? "compression=none" : property.exitCode === 0 ? property.stdout.trim() || "unset" : "unreadable",
			})
		}

		const passed = checks.filter((entry) => entry.ok).length
		const failed = checks.length - passed

		context.log(`${passed}/${checks.length} checks pass`)

		return { mountPoint, checks, passed, failed }
	},
	formatOutput(output) {
		const lines = output.checks.map((entry) => `  ${entry.ok ? "✓" : "✗"} ${entry.name} — ${entry.detail}`)

		return [`${output.mountPoint}: ${output.passed} passed, ${output.failed} failed`, ...lines].join("\n")
	},
})
