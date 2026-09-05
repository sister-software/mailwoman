/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The release registry as an MCP tool table — the pure half of this server, so the mapping from an operation to a
 *   tool can be tested against a synthetic registry with no transport.
 *
 *   ONE OPERATION, ONE TOOL, THE EFFECT IN THE NAME'S NEIGHBOUR. `release.verify-metadata` becomes `release_verify_metadata`
 *   and its description opens with `[read]`, `[local-write]` or `[external-write]`, the effect the registry declares
 *   rather than anything inferred here. A local-write tool gains a `dry_run` argument the operation's own schema does
 *   not carry, because the context flag is the adapter's to thread.
 *
 *   THE TWO PUBLISHING OPERATIONS ARE OFF BY DEFAULT. An MCP session that receives this server must not thereby receive
 *   npm authority — the same posture `@mailwoman/dev-mcp` states for itself. `publish-workspace` and `bless-package` are
 *   registered only when the server is started with `--allow-external-write`, and even then they run the plan → execute
 *   contract the operations enforce themselves: a plan file whose digest must match a recomputed one on an unmoved,
 *   clean HEAD. This table never bypasses that, and carries no release logic of its own.
 */

import { OperationEffect, type ReleaseContext, type ReleaseOperation } from "@mailwoman/release-kit"
import { z, type ZodObject, type ZodRawShape } from "zod"

export interface ReleaseTool {
	name: string
	description: string
	/**
	 * The operation's own input schema, plus `dry_run` on a writing operation.
	 */
	inputSchema: ZodObject<ZodRawShape>
	effect: (typeof OperationEffect)[keyof typeof OperationEffect]
	handler: (args: Record<string, unknown>) => Promise<ReleaseToolResult>
}

/**
 * What every tool answers: the operation's output beside the effect it declared, the dry-run flag it ran under, and the
 * progress lines the operation logged — a receipt a reader can check without a terminal.
 */
export interface ReleaseToolResult {
	operation: string
	effect: string
	dry_run: boolean
	output: unknown
	log: string[]
}

export interface ReleaseToolTableOptions {
	repoRoot: string
	/**
	 * Register the `external-write` operations too. Off by default, and the CLI exposes it as an explicit flag.
	 */
	allowExternalWrite?: boolean
}

/**
 * `release.verify-metadata` → `release_verify_metadata`.
 */
export function toolNameFor(operationID: string): string {
	return operationID.replaceAll(".", "_").replaceAll("-", "_")
}

/**
 * Build the tool table over a registry. The operation's `inputSchema` must be an object schema: a tool's arguments are
 * a JSON object, and an operation that took anything else could not be called from any client, so it is refused here by
 * id rather than registered as a tool nobody can invoke.
 */
export function buildReleaseToolTable(
	registry: ReadonlyArray<ReleaseOperation<unknown, unknown>>,
	options: ReleaseToolTableOptions
): ReleaseTool[] {
	const tools: ReleaseTool[] = []

	for (const operation of registry) {
		if (operation.effect === OperationEffect.ExternalWrite && !options.allowExternalWrite) continue

		const inputSchema = operation.inputSchema as unknown

		if (!isObjectSchema(inputSchema)) {
			throw new Error(
				`release-mcp: ${operation.id} declares a non-object inputSchema; a tool's arguments are a JSON object`
			)
		}

		const writes = operation.effect !== OperationEffect.Read
		const schema = writes ? inputSchema.extend({ dry_run: z.boolean().optional() }) : inputSchema

		tools.push({
			name: toolNameFor(operation.id),
			effect: operation.effect,
			description:
				`[${operation.effect}] ${operation.description}` +
				(writes ? " Pass dry_run: true to have the operation describe what it would write and write nothing." : "") +
				(operation.effect === OperationEffect.ExternalWrite
					? " Reachable only through the plan → execute contract the operation enforces: a --plan file from release_plan whose digest must still match on an unmoved, clean HEAD."
					: ""),
			inputSchema: schema,
			handler: async (args) => {
				const { dry_run, ...input } = args
				const log: string[] = []

				const context: ReleaseContext = {
					repoRoot: options.repoRoot,
					dryRun: writes && dry_run === true,
					log: (line) => log.push(line),
				}

				const output = await operation.run(operation.inputSchema.parse(input), context)

				return { operation: operation.id, effect: operation.effect, dry_run: context.dryRun, output, log }
			},
		})
	}

	return tools
}

/**
 * The one tool that is not an operation: the registry itself, with the effect of every operation and whether this
 * server exposes it — so an agent that cannot see a publishing tool learns that it exists and why it is absent.
 */
export function registryTool(
	registry: ReadonlyArray<ReleaseOperation<unknown, unknown>>,
	options: ReleaseToolTableOptions
): ReleaseTool {
	return {
		name: "release_operations",
		effect: OperationEffect.Read,
		description:
			"[read] Every registered release operation with its declared effect, and whether this server exposes it as a tool. The external-write operations are listed here whether or not they are exposed.",
		inputSchema: z.object({}),
		handler: async () => ({
			operation: "release.operations",
			effect: OperationEffect.Read,
			dry_run: false,
			output: registry.map((operation) => ({
				id: operation.id,
				tool: toolNameFor(operation.id),
				effect: operation.effect,
				exposed: operation.effect !== OperationEffect.ExternalWrite || options.allowExternalWrite === true,
				description: operation.description,
			})),
			log: [],
		}),
	}
}

function isObjectSchema(schema: unknown): schema is ZodObject<ZodRawShape> {
	return (
		typeof schema === "object" &&
		schema !== null &&
		"shape" in schema &&
		typeof (schema as { extend?: unknown }).extend === "function"
	)
}
