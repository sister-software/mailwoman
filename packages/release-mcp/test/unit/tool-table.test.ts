/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The release tool table over a synthetic registry: which operations become tools, what they are called, what a
 *   writing tool gains, and what a call answers.
 */

import { defineOperation, OperationEffect, type ReleaseOperation } from "@mailwoman/release-kit"
import { buildReleaseToolTable, registryTool, toolNameFor } from "@mailwoman/release-mcp"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const read = defineOperation({
	id: "release.verify-metadata",
	description: "Check the manifests.",
	effect: OperationEffect.Read,
	inputSchema: z.object({ strict: z.boolean().optional() }),
	outputSchema: z.object({ ok: z.boolean() }),
	run: async (input, context) => {
		context.log(`verifying in ${context.repoRoot}`)

		return { ok: input.strict !== false }
	},
})

const localWrite = defineOperation({
	id: "release.copy-weights",
	description: "Materialize the binaries.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ locale: z.string() }),
	outputSchema: z.object({ wrote: z.number(), dryRun: z.boolean() }),
	run: async (_input, context) => ({ wrote: context.dryRun ? 0 : 1, dryRun: context.dryRun }),
})

const externalWrite = defineOperation({
	id: "release.publish-workspace",
	description: "Publish one tarball.",
	effect: OperationEffect.ExternalWrite,
	inputSchema: z.object({ plan: z.string() }),
	outputSchema: z.object({ published: z.boolean() }),
	run: async () => ({ published: true }),
})

const registry = [read, localWrite, externalWrite] as ReadonlyArray<ReleaseOperation<unknown, unknown>>

describe("buildReleaseToolTable", () => {
	it("names a tool after its operation id, dots and dashes as underscores", () => {
		expect(toolNameFor("release.verify-metadata")).toBe("release_verify_metadata")

		expect(buildReleaseToolTable(registry, { repoRoot: "/repo" }).map((tool) => tool.name)).toEqual([
			"release_verify_metadata",
			"release_copy_weights",
		])
	})

	it("leaves the external-write operations off the table unless asked", () => {
		const closed = buildReleaseToolTable(registry, { repoRoot: "/repo" })
		const open = buildReleaseToolTable(registry, { repoRoot: "/repo", allowExternalWrite: true })

		expect(closed.some((tool) => tool.effect === OperationEffect.ExternalWrite)).toBe(false)
		expect(open.map((tool) => tool.name)).toContain("release_publish_workspace")
		expect(open.find((tool) => tool.name === "release_publish_workspace")!.description).toMatch(/plan → execute/u)
	})

	it("opens every description with the declared effect", () => {
		for (const tool of buildReleaseToolTable(registry, { repoRoot: "/repo", allowExternalWrite: true })) {
			expect(tool.description.startsWith(`[${tool.effect}]`)).toBe(true)
		}
	})

	it("gives a writing tool a dry_run argument and a reading tool none", () => {
		const [verify, copy] = buildReleaseToolTable(registry, { repoRoot: "/repo" })

		expect(Object.keys(verify!.inputSchema.shape)).toEqual(["strict"])
		expect(Object.keys(copy!.inputSchema.shape)).toEqual(["locale", "dry_run"])
	})

	it("runs the operation with the adapter's context and answers a receipt", async () => {
		const [verify, copy] = buildReleaseToolTable(registry, { repoRoot: "/repo" })

		expect(await verify!.handler({ strict: true })).toEqual({
			operation: "release.verify-metadata",
			effect: "read",
			dry_run: false,
			output: { ok: true },
			log: ["verifying in /repo"],
		})

		expect(await copy!.handler({ locale: "en-us", dry_run: true })).toMatchObject({
			dry_run: true,
			output: { wrote: 0, dryRun: true },
		})

		expect(await copy!.handler({ locale: "en-us" })).toMatchObject({ dry_run: false, output: { wrote: 1 } })
	})

	it("refuses an operation's input the schema refuses, by the operation's own message", async () => {
		const [, copy] = buildReleaseToolTable(registry, { repoRoot: "/repo" })

		await expect(copy!.handler({})).rejects.toThrow(/locale/u)
	})

	it("refuses a registry whose operation takes a non-object input", () => {
		const scalar = defineOperation({
			id: "release.oddity",
			description: "Takes a string.",
			effect: OperationEffect.Read,
			inputSchema: z.string(),
			outputSchema: z.string(),
			run: async (input) => input,
		}) as ReleaseOperation<unknown, unknown>

		expect(() => buildReleaseToolTable([scalar], { repoRoot: "/repo" })).toThrow(/non-object inputSchema/u)
	})
})

describe("registryTool", () => {
	it("lists every operation with its effect and whether the server exposes it", async () => {
		const result = await registryTool(registry, { repoRoot: "/repo" }).handler({})

		expect(result.output).toEqual([
			{
				id: "release.verify-metadata",
				tool: "release_verify_metadata",
				effect: "read",
				exposed: true,
				description: "Check the manifests.",
			},
			{
				id: "release.copy-weights",
				tool: "release_copy_weights",
				effect: "local-write",
				exposed: true,
				description: "Materialize the binaries.",
			},
			{
				id: "release.publish-workspace",
				tool: "release_publish_workspace",
				effect: "external-write",
				exposed: false,
				description: "Publish one tarball.",
			},
		])
	})
})
