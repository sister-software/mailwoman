// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The AWS credential operations: report each role's identity, and create the scoped
 *   identities with an access key written to a new file.
 *
 *   The roles live in `#release-kit/deploy/aws/credentials`, and every request
 *   runs through `#release-kit/deploy/aws/cli`.
 */

import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { writePrivateTextFile } from "@mailwoman/core/fs/writers"
import { OperationEffect } from "@mailwoman/core/scripting"
import { isProcessError } from "@mailwoman/core/scripting/process"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/values/json"
import { resolvePath } from "path-ts"
import { z } from "zod"

import {
	type AccessKey,
	aws,
	type AWSCaller,
	callerIdentity,
	readAWSResource,
	tileBuildKey,
} from "#release-kit/deploy/aws/cli"
import {
	AWS_CREDENTIAL_ROLES,
	type AWSCredentialRole,
	AWSCredentialRoleID,
	type AWSServiceRole,
	type AWSUserRole,
	findAWSCredentialRole,
} from "#release-kit/deploy/aws/credentials"
import { defineOperation } from "#release-kit/operation"
import { flag, list, text } from "#release-kit/operations/inputs"

function roleKey(role: AWSUserRole): AccessKey | null {
	switch (role.id) {
		case AWSCredentialRoleID.TileBuild:
			return tileBuildKey()

		default:
			return null
	}
}

const roleKind = z.enum(["user", "service"])

const roleReport = z.object({
	role: z.string(),
	kind: roleKind,
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
		"Verify each AWS credential role's access key from the environment against AWS STS. A service role has no key and is listed without a check. Run mint-aws-credentials to create them.",
	effect: OperationEffect.Read,
	options: {},
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({ roles: z.array(roleReport) }),
	async run() {
		const roles = await Promise.all(
			AWS_CREDENTIAL_ROLES.map(async (role) => {
				const base = { role: role.id, kind: role.kind, name: role.name, purpose: role.purpose }

				if (role.kind === "service") {
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
 * The trust policy that lets one AWS service assume a role.
 */
function trustPolicy(service: string): string {
	return stringifyJSON({
		Version: "2012-10-17",
		Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
	})
}

/**
 * Creates or updates one service role: the role, its trust, inline and managed policies,
 * and its instance profile when it has one.
 */
async function writeServiceRole(
	caller: AWSCaller,
	role: AWSServiceRole,
	accountID: string,
	log: (line: string) => void
): Promise<void> {
	if (await readAWSResource(caller, ["iam", "get-role", "--role-name", role.name])) {
		await aws(caller, [
			"iam",
			"update-assume-role-policy",
			"--role-name",
			role.name,
			"--policy-document",
			trustPolicy(role.service),
		])
	} else {
		await aws(caller, [
			"iam",
			"create-role",
			"--role-name",
			role.name,
			"--assume-role-policy-document",
			trustPolicy(role.service),
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

	if (!role.instanceProfile) return

	if (!(await readAWSResource(caller, ["iam", "get-instance-profile", "--instance-profile-name", role.name]))) {
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

	if (!(await readAWSResource(caller, ["iam", "get-policy", "--policy-arn", arn]))) {
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

/**
 * Creates the user when it is absent and attaches its managed policy.
 */
async function writeUser(
	caller: AWSCaller,
	role: AWSUserRole,
	accountID: string,
	log: (line: string) => void
): Promise<void> {
	if (!(await readAWSResource(caller, ["iam", "get-user", "--user-name", role.name]))) {
		await aws(caller, ["iam", "create-user", "--user-name", role.name])
		log(`created user ${role.name}`)
	}

	const policyARN = await writeManagedPolicy(caller, role.name, stringifyJSON(role.policy(accountID)), accountID)

	await aws(caller, ["iam", "attach-user-policy", "--user-name", role.name, "--policy-arn", policyARN])
	log(`attached policy ${policyARN} to user ${role.name}`)
}

const mintedIdentity = z.object({
	role: z.string(),
	kind: roleKind,
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
		"Create the scoped AWS identities (--roles tile-scheduler,tile-instance,tile-build; default all): an IAM user with one access key, and service roles, one with an instance profile. Writes each new key as KEY=value lines to a new file, --out/-o, readable only by its owner. --policies-only rewrites every policy and creates no key, so it needs no --out. Runs as the shell's AWS session, or as --profile, which needs IAM write access. --replace deletes a user's earlier access keys after the file is written.",
	effect: OperationEffect.ExternalWrite,
	options: {
		out: { type: "string", short: "o" },
		roles: { type: "string" },
		profile: { type: "string" },
		replace: { type: "boolean" },
		"policies-only": { type: "boolean" },
	},
	inputSchema: z
		.object({ out: text, roles: list, profile: text, replace: flag, "policies-only": flag })
		.strict()
		.refine((input) => input["policies-only"] || input.out, { message: "--out <file> is required" }),
	outputSchema: z.object({
		out: z.string().nullable(),
		account: z.string(),
		minter: z.string(),
		minted: z.array(mintedIdentity),
	}),
	async run(input, context) {
		const roles: readonly AWSCredentialRole[] = input.roles.length
			? AWS_CREDENTIAL_ROLES.filter((role) => input.roles.map(findAWSCredentialRole).includes(role))
			: AWS_CREDENTIAL_ROLES

		const policiesOnly = input["policies-only"]
		const out = policiesOnly || !input.out ? null : resolvePath(input.out)

		if (out && (await tryStat(out))) throw new Error(`${out} exists; name a new file`)

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
			if (role.kind !== "user" || policiesOnly) continue

			const user = await readAWSResource(caller, ["iam", "get-user", "--user-name", role.name])

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
				`access keys already exist for ${blocked.map((role) => `${role.id} (${earlier.get(role)!.join(", ")})`).join("; ")}; pass --replace to delete them after the new keys are written, or --policies-only to rewrite the policies alone`
			)
		}

		const replaced = (role: AWSCredentialRole): string[] => (input.replace ? (earlier.get(role) ?? []) : [])

		const envOf = (role: AWSCredentialRole): string[] =>
			role.kind === "user" ? [role.env.accessKeyID, role.env.secretAccessKey] : []

		if (context.dryRun) {
			return {
				out: out?.toString() ?? null,
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
			if (role.kind === "service") {
				await writeServiceRole(caller, role, accountID, context.log)
				created.push({ role, key: null })

				continue
			}

			await writeUser(caller, role, accountID, context.log)

			if (policiesOnly) {
				created.push({ role, key: null })

				continue
			}

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

		if (out) {
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
		}

		for (const { role } of created) {
			for (const id of replaced(role)) {
				await aws(caller, ["iam", "delete-access-key", "--user-name", role.name, "--access-key-id", id])
				context.log(`deleted the earlier access key ${id} of user ${role.name}`)
			}
		}

		return {
			out: out?.toString() ?? null,
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
				? `${identity.role}: user ${identity.name}${identity.accessKeyID ? `, ${identity.env.join(" and ")} = key ${identity.accessKeyID}` : ", policy written"}${identity.replaced.length ? `, replacing ${identity.replaced.join(", ")}` : ""}`
				: `${identity.role}: role ${identity.name}`
		)

		return [
			`account ${account}, minted as ${minter}`,
			out ? `wrote ${out} (mode 0600)` : "policies only: no key file",
			...lines,
		].join("\n")
	},
})
