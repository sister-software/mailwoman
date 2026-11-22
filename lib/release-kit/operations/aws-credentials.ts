// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The AWS credential operations: report each role's identity, and create the scoped
 *   identities with an access key written to a new file.
 *   The roles live in `#release-kit/deploy/aws-credentials`.
 *
 *   Every request goes through the `aws` program, so the mint runs under whatever session
 *   the operator's shell holds and this workspace takes on no AWS SDK client.
 */

import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { writePrivateTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { OperationEffect } from "@mailwoman/core/scripting"
import { resolvePath } from "path-ts"
import { z } from "zod"

import {
	AWS_BUILD_REGION,
	AWS_CREDENTIAL_ROLES,
	type AWSCredentialRole,
	AWSCredentialRoleID,
	type AWSUserRole,
	findAWSCredentialRole,
} from "#release-kit/deploy/aws-credentials"
import { $private } from "#release-kit/env"
import { defineOperation } from "#release-kit/operation"
import { flag, list, text } from "#release-kit/operations/inputs"

/**
 * An access key as two environment values.
 */
interface AccessKey {
	accessKeyID: string
	secretAccessKey: string
}

/**
 * Who a request runs as: a profile of the operator's AWS configuration,
 * an access key, or the shell's own session.
 */
type AWSCaller = { profile: string } | { key: AccessKey } | null

/**
 * The error text IAM answers for a user, role or instance profile that doesn't exist.
 */
const NO_SUCH_ENTITY = "NoSuchEntity"

/**
 * Runs one `aws` request and answers its JSON output, or null when the request prints none.
 */
async function aws<T>(caller: AWSCaller, args: readonly string[]): Promise<T | null> {
	const profile = caller && "profile" in caller ? ["--profile", caller.profile] : []

	// `execFile`'s `env` replaces the inherited environment, so a key extends a copy of it.
	// The empty session token and profile keep the shell's own session out of a request made with the key.
	const options =
		caller && "key" in caller
			? {
					env: {
						// oxlint-disable-next-line sister-software/no-process-globals -- the child must inherit the path and the rest. No typed helper exposes the whole environment.
						...process.env,
						AWS_ACCESS_KEY_ID: caller.key.accessKeyID,
						AWS_SECRET_ACCESS_KEY: caller.key.secretAccessKey,
						AWS_SESSION_TOKEN: "",
						AWS_PROFILE: "",
					},
				}
			: {}

	const { stdout } = await runFile(
		"aws",
		[...args, ...profile, "--region", AWS_BUILD_REGION, "--output", "json"],
		options
	)

	return stdout.trim() ? parseJSONStrict<T>(stdout) : null
}

/**
 * Runs a read of one IAM entity and answers null when IAM reports that the entity doesn't exist.
 *
 * Any other failure, such as a refused permission, is thrown: an unreadable entity isn't an absent one.
 */
async function readEntity<T>(caller: AWSCaller, args: readonly string[]): Promise<T | null> {
	try {
		return await aws<T>(caller, args)
	} catch (error) {
		if (isProcessError(error) && String(error.stderr).includes(NO_SUCH_ENTITY)) return null

		throw error
	}
}

function roleKey(role: AWSUserRole): AccessKey | null {
	switch (role.id) {
		case AWSCredentialRoleID.TileBuild: {
			const accessKeyID = $private.AWS_TILE_BUILD_ACCESS_KEY_ID
			const secretAccessKey = $private.AWS_TILE_BUILD_SECRET_ACCESS_KEY

			return accessKeyID && secretAccessKey ? { accessKeyID, secretAccessKey } : null
		}

		default:
			return null
	}
}

interface CallerIdentity {
	Account: string
	Arn: string
}

async function callerIdentity(caller: AWSCaller): Promise<CallerIdentity> {
	const identity = await aws<CallerIdentity>(caller, ["sts", "get-caller-identity"])

	if (!identity) throw new Error("aws sts get-caller-identity printed no identity")

	return identity
}

const roleReport = z.object({
	role: z.string(),
	kind: z.enum(["user", "instance"]),
	name: z.string(),
	env: z.array(z.string()),
	purpose: z.string(),
	state: z.enum(["unset", "active", "refused", "not-checked"]),
	arn: z.string().nullable(),
	detail: z.string().nullable(),
})

/**
 * `release.aws-credentials`: each role's identity as AWS reports it for the key in the environment.
 */
export const awsCredentials = defineOperation({
	id: "release.aws-credentials",
	description:
		"Verify each AWS credential role's access key from the environment against AWS STS. An instance role has no key and is listed without a check. Run mint-aws-credentials to create them.",
	effect: OperationEffect.Read,
	options: {},
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({ roles: z.array(roleReport) }),
	async run() {
		const roles = await Promise.all(
			AWS_CREDENTIAL_ROLES.map(async (role) => {
				const base = { role: role.id, kind: role.kind, name: role.name, purpose: role.purpose }

				if (role.kind === "instance") {
					return { ...base, env: [], state: "not-checked" as const, arn: null, detail: null }
				}

				const env = [role.env.accessKeyID, role.env.secretAccessKey]
				const key = roleKey(role)

				if (!key) return { ...base, env, state: "unset" as const, arn: null, detail: null }

				try {
					const identity = await callerIdentity({ key })
					const expected = identity.Arn.endsWith(`:user/${role.name}`)

					return {
						...base,
						env,
						state: expected ? ("active" as const) : ("refused" as const),
						arn: identity.Arn,
						detail: expected ? null : `the key belongs to another identity than ${role.name}`,
					}
				} catch (error) {
					const detail = isProcessError(error) ? String(error.stderr).trim() : String(error)

					return { ...base, env, state: "refused" as const, arn: null, detail }
				}
			})
		)

		return { roles }
	},
	formatOutput({ roles }) {
		return roles
			.map((role) =>
				[
					`${role.role} (${role.kind} ${role.name}): ${role.state}${role.arn ? `, ${role.arn}` : ""}`,
					`  ${role.purpose}`,
					...(role.env.length ? [`  env: ${role.env.join(", ")}`] : []),
					...(role.detail ? [`  ${role.detail}`] : []),
				].join("\n")
			)
			.join("\n\n")
	},
})

/**
 * The trust policy that lets an EC2 instance assume a role.
 */
const INSTANCE_TRUST_POLICY = {
	Version: "2012-10-17",
	Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
}

/**
 * Creates or updates one instance role: the role, its inline and managed policies, and its instance profile.
 */
async function writeInstanceRole(
	caller: AWSCaller,
	role: Extract<AWSCredentialRole, { kind: "instance" }>,
	accountID: string,
	log: (line: string) => void
): Promise<void> {
	if (!(await readEntity(caller, ["iam", "get-role", "--role-name", role.name]))) {
		await aws(caller, [
			"iam",
			"create-role",
			"--role-name",
			role.name,
			"--assume-role-policy-document",
			stringifyJSON(INSTANCE_TRUST_POLICY),
			"--description",
			role.purpose,
		])

		log(`created role ${role.name}`)
	}

	await aws(caller, [
		"iam",
		"put-role-policy",
		"--role-name",
		role.name,
		"--policy-name",
		role.name,
		"--policy-document",
		stringifyJSON(role.policy(accountID)),
	])

	for (const policy of role.managedPolicies) {
		await aws(caller, ["iam", "attach-role-policy", "--role-name", role.name, "--policy-arn", policy])
	}

	log(`wrote the policies of role ${role.name}`)

	if (!(await readEntity(caller, ["iam", "get-instance-profile", "--instance-profile-name", role.name]))) {
		await aws(caller, ["iam", "create-instance-profile", "--instance-profile-name", role.name])

		await aws(caller, [
			"iam",
			"add-role-to-instance-profile",
			"--instance-profile-name",
			role.name,
			"--role-name",
			role.name,
		])

		log(`created instance profile ${role.name}`)
	}
}

/**
 * The most versions IAM keeps of one managed policy.
 */
const POLICY_VERSION_LIMIT = 5

/**
 * Creates the customer-managed policy `name`, or makes `document` its default version, and answers its ARN.
 *
 * A user's inline policies may total 2,048 bytes, and the tile-build policy is larger.
 * A managed policy may hold 6,144 bytes.
 *
 * IAM keeps five versions of one policy.
 * The oldest version that isn't the default is deleted to make room for a sixth.
 */
async function writeManagedPolicy(
	caller: AWSCaller,
	name: string,
	document: string,
	accountID: string
): Promise<string> {
	const arn = `arn:aws:iam::${accountID}:policy/${name}`

	if (!(await readEntity(caller, ["iam", "get-policy", "--policy-arn", arn]))) {
		await aws(caller, ["iam", "create-policy", "--policy-name", name, "--policy-document", document])

		return arn
	}

	const listed = await aws<{ Versions: Array<{ VersionId: string; IsDefaultVersion: boolean; CreateDate: string }> }>(
		caller,
		["iam", "list-policy-versions", "--policy-arn", arn]
	)

	const versions = listed?.Versions ?? []

	if (versions.length >= POLICY_VERSION_LIMIT) {
		const oldest = versions
			.filter((version) => !version.IsDefaultVersion)
			.toSorted((a, b) => a.CreateDate.localeCompare(b.CreateDate))[0]

		if (oldest) {
			await aws(caller, ["iam", "delete-policy-version", "--policy-arn", arn, "--version-id", oldest.VersionId])
		}
	}

	await aws(caller, [
		"iam",
		"create-policy-version",
		"--policy-arn",
		arn,
		"--policy-document",
		document,
		"--set-as-default",
	])

	return arn
}

const mintedIdentity = z.object({
	role: z.string(),
	kind: z.enum(["user", "instance"]),
	name: z.string(),
	env: z.array(z.string()),
	accessKeyID: z.string().nullable(),
	replaced: z.array(z.string()),
})

/**
 * `release.mint-aws-credentials`: create each role's identity and write the user roles' keys to a new file.
 */
export const mintAWSCredentials = defineOperation({
	id: "release.mint-aws-credentials",
	description:
		"Create the scoped AWS identities (--roles tile-instance,tile-build; default both): an IAM user with one access key, and an instance role with its instance profile. Writes each key as KEY=value lines to a new file, --out/-o, readable only by its owner. Runs as the shell's AWS session, or as --profile, which needs IAM write access. --replace deletes a user's earlier access keys after the file is written.",
	effect: OperationEffect.ExternalWrite,
	options: {
		out: { type: "string", short: "o" },
		roles: { type: "string" },
		profile: { type: "string" },
		replace: { type: "boolean" },
	},
	inputSchema: z
		.object({ out: z.string({ error: "--out <file> is required" }), roles: list, profile: text, replace: flag })
		.strict(),
	outputSchema: z.object({ out: z.string(), account: z.string(), minter: z.string(), minted: z.array(mintedIdentity) }),
	async run(input, context) {
		const roles: readonly AWSCredentialRole[] = input.roles.length
			? AWS_CREDENTIAL_ROLES.filter((role) => input.roles.map(findAWSCredentialRole).includes(role))
			: AWS_CREDENTIAL_ROLES

		const out = resolvePath(input.out)

		if (await tryStat(out)) throw new Error(`${out} exists; name a new file`)

		const caller: AWSCaller = input.profile ? { profile: input.profile } : null
		const identity = await callerIdentity(caller)
		const accountID = identity.Account

		// A dry run prints each policy before the IAM reads, so a session without IAM access still shows them.
		if (context.dryRun) {
			for (const role of roles) {
				context.log(`would write ${role.kind} ${role.name} in account ${accountID} as ${identity.Arn}:`)
				context.log(prettyJSON(role.policy(accountID)))
			}
		}

		// Every user's existing keys are read before the first write, so a refusal changes no identity.
		const earlier = new Map<AWSCredentialRole, string[]>()

		for (const role of roles) {
			if (role.kind !== "user") continue

			const user = await readEntity(caller, ["iam", "get-user", "--user-name", role.name])

			const keys = user
				? await aws<{ AccessKeyMetadata: Array<{ AccessKeyId: string }> }>(caller, [
						"iam",
						"list-access-keys",
						"--user-name",
						role.name,
					])
				: null

			earlier.set(role, keys?.AccessKeyMetadata.map((key) => key.AccessKeyId) ?? [])
		}

		const blocked = roles.filter((role) => earlier.get(role)?.length && !input.replace)

		if (blocked.length) {
			throw new Error(
				`access keys already exist for ${blocked.map((role) => `${role.id} (${earlier.get(role)!.join(", ")})`).join("; ")}; pass --replace to delete them after the new keys are written`
			)
		}

		const replaced = (role: AWSCredentialRole): string[] => (input.replace ? (earlier.get(role) ?? []) : [])

		const envOf = (role: AWSCredentialRole): string[] =>
			role.kind === "user" ? [role.env.accessKeyID, role.env.secretAccessKey] : []

		if (context.dryRun) {
			return {
				out: out.toString(),
				account: accountID,
				minter: identity.Arn,
				minted: roles.map((role) => ({
					role: role.id,
					kind: role.kind,
					name: role.name,
					env: envOf(role),
					accessKeyID: null,
					replaced: replaced(role),
				})),
			}
		}

		const created: Array<{ role: AWSCredentialRole; key: AccessKey | null }> = []

		for (const role of roles) {
			if (role.kind === "instance") {
				await writeInstanceRole(caller, role, accountID, context.log)
				created.push({ role, key: null })

				continue
			}

			if (!(await readEntity(caller, ["iam", "get-user", "--user-name", role.name]))) {
				await aws(caller, ["iam", "create-user", "--user-name", role.name])
				context.log(`created user ${role.name}`)
			}

			const policyARN = await writeManagedPolicy(caller, role.name, stringifyJSON(role.policy(accountID)), accountID)

			await aws(caller, ["iam", "attach-user-policy", "--user-name", role.name, "--policy-arn", policyARN])
			context.log(`attached policy ${policyARN} to user ${role.name}`)

			const result = await aws<{ AccessKey: { AccessKeyId: string; SecretAccessKey: string } }>(caller, [
				"iam",
				"create-access-key",
				"--user-name",
				role.name,
			])

			if (!result) throw new Error(`AWS created an access key for ${role.name} without returning it`)

			context.log(`created access key ${result.AccessKey.AccessKeyId} for user ${role.name}`)

			created.push({
				role,
				key: { accessKeyID: result.AccessKey.AccessKeyId, secretAccessKey: result.AccessKey.SecretAccessKey },
			})
		}

		await writePrivateTextFile(
			created
				.flatMap(({ role, key }) =>
					role.kind === "user" && key
						? [`${role.env.accessKeyID}=${key.accessKeyID}\n`, `${role.env.secretAccessKey}=${key.secretAccessKey}\n`]
						: []
				)
				.join(""),
			out
		)

		for (const { role } of created) {
			for (const id of replaced(role)) {
				await aws(caller, ["iam", "delete-access-key", "--user-name", role.name, "--access-key-id", id])
				context.log(`deleted the earlier access key ${id} of user ${role.name}`)
			}
		}

		return {
			out: out.toString(),
			account: accountID,
			minter: identity.Arn,
			minted: created.map(({ role, key }) => ({
				role: role.id,
				kind: role.kind,
				name: role.name,
				env: envOf(role),
				accessKeyID: key?.accessKeyID ?? null,
				replaced: replaced(role),
			})),
		}
	},
	formatOutput({ out, account, minter, minted }) {
		const lines = minted.map((identity) =>
			identity.kind === "user"
				? `${identity.role}: user ${identity.name}, ${identity.env.join(" and ")}${identity.accessKeyID ? ` = key ${identity.accessKeyID}` : " (dry run)"}${identity.replaced.length ? `, replacing ${identity.replaced.join(", ")}` : ""}`
				: `${identity.role}: role and instance profile ${identity.name}`
		)

		return [`account ${account}, minted as ${minter}`, `wrote ${out} (mode 0600)`, ...lines].join("\n")
	},
})
