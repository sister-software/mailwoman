/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two host-configuration writes the storage operations depend on, as operations rather than a
 *   shell script: they take typed input, declare their effect, and are reachable from the same
 *   registry as everything else.
 */

import { writeFile } from "node:fs/promises"

import { z } from "zod"
import { $ } from "zx"

import { renderSudoersRule, renderUdevRule } from "#host-rules"
import { assertRoot, defineOperation, StorageEffect } from "#operation"

const writeOutput = z.object({ path: z.string(), bytes: z.number(), reloaded: z.boolean() })

/**
 * `storage.install-udev-rule` — keep discard enabled on a USB SSD across replugs.
 */
export const installUdevRuleOperation = defineOperation({
	id: "storage.install-udev-rule",
	description:
		"Install a udev rule that keeps TRIM enabled on a USB-attached SSD whose bridge supports UNMAP but not WRITE SAME.",
	effect: StorageEffect.HostWrite,
	inputSchema: z
		.object({
			vendor: z.string().default("04e8").describe("USB vendor id, as `lsusb` prints it."),
			product: z.string().default("61fb").describe("USB product id."),
			path: z.string().default("/etc/udev/rules.d/60-ssd-unmap.rules").describe("Where the rule is written."),
		})
		.strict(),
	outputSchema: writeOutput,
	async run(input, context) {
		const body = renderUdevRule(input.vendor, input.product)

		if (context.dryRun) {
			context.log(`dry run — would write ${body.length} bytes to ${input.path}`)

			return { path: input.path, bytes: body.length, reloaded: false }
		}

		assertRoot(context, "storage.install-udev-rule")
		await writeFile(input.path, body, "utf8")
		context.log(`  wrote ${input.path}`)

		const reload = await $({ nothrow: true, quiet: true })`udevadm control --reload-rules`

		const trigger = await $({
			nothrow: true,
			quiet: true,
		})`udevadm trigger --subsystem-match=scsi_disk --action=change`

		const reloaded = reload.exitCode === 0 && trigger.exitCode === 0

		context.log(reloaded ? "  rules reloaded and retriggered" : "  WARNING: udevadm reload failed; replug to apply")

		return { path: input.path, bytes: body.length, reloaded }
	},
	formatOutput: (output) => `${output.path} (${output.bytes} bytes)${output.reloaded ? ", reloaded" : ""}`,
})

/**
 * `storage.install-sudoers` — let the CLI acquire root unattended.
 *
 * Refuses unless the caller passes `--accept-risk`, because the rule covers every
 * mwops verb and grants the target user unattended root.
 * See {@linkcode renderSudoersRule} for what that means.
 */
export const installSudoersOperation = defineOperation({
	id: "storage.install-sudoers",
	description:
		"Install a passwordless-sudo rule for the mwops CLI. Grants unattended root for EVERY verb — requires --accept-risk.",
	effect: StorageEffect.HostWrite,
	inputSchema: z
		.object({
			user: z.string().describe("The user the rule grants root to."),
			"node-path": z.string().describe("Absolute path of the node binary, symlinks resolved."),
			"cli-path": z.string().describe("Absolute path of the mwops entry point."),
			path: z.string().default("/etc/sudoers.d/mailwoman-storage").describe("Where the rule is written."),
			"accept-risk": z
				.union([z.boolean(), z.string()])
				.optional()
				.transform((value) => value === true || value === "true"),
		})
		.strict(),
	outputSchema: writeOutput,
	async run(input, context) {
		if (!input["accept-risk"]) {
			throw new Error(
				"storage.install-sudoers grants the named user unattended root for every mwops verb, not only storage. " +
					"Nothing requires it — without it `storage prepare` prompts for a password like any other sudo command. " +
					"Pass --accept-risk once you have read renderSudoersRule's caveats."
			)
		}

		const body = renderSudoersRule(input.user, input["node-path"], input["cli-path"])

		if (context.dryRun) {
			context.log(`dry run — would write ${body.length} bytes to ${input.path}`)

			return { path: input.path, bytes: body.length, reloaded: false }
		}

		assertRoot(context, "storage.install-sudoers")

		// Validated before it lands: a malformed file in sudoers.d breaks sudo for everyone.
		const staged = `${input.path}.staged`

		await writeFile(staged, body, "utf8")

		const check = await $({ nothrow: true, quiet: true })`visudo -cf ${staged}`

		if (check.exitCode !== 0) {
			await $({ nothrow: true, quiet: true })`rm -f ${staged}`

			throw new Error(`generated sudoers file failed visudo validation:\n${check.stderr || check.stdout}`)
		}

		await $({ nothrow: true, quiet: true })`install -m 0440 -o root -g root ${staged} ${input.path}`
		await $({ nothrow: true, quiet: true })`rm -f ${staged}`
		context.log(`  wrote ${input.path} (validated by visudo)`)

		return { path: input.path, bytes: body.length, reloaded: false }
	},
	formatOutput: (output) => `${output.path} (${output.bytes} bytes)`,
})
