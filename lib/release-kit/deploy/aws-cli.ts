// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Runs the `aws` program for the release-kit's AWS operations.
 *
 *   Every request goes through the program, so a mint runs under whatever session the operator's shell holds and
 *   the workspace takes on no AWS SDK client. A request runs as a profile from the operator's AWS configuration,
 *   as an explicit access key, or as the shell's own session.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { isProcessError, runFile } from "@mailwoman/core/process"

import { AWS_BUILD_REGION } from "#release-kit/deploy/aws-credentials"
import { $private } from "#release-kit/env"

/**
 * An access key as two environment values.
 */
export interface AccessKey {
	accessKeyID: string
	secretAccessKey: string
}

/**
 * Who a request runs as: a profile of the operator's AWS configuration,
 * an access key, or the shell's own session.
 */
export type AWSCaller = { profile: string } | { key: AccessKey } | null

/**
 * The environment variables that select a session other than an explicit access key.
 */
const SESSION_VARIABLES: ReadonlySet<string> = new Set(["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"])

/**
 * The error text IAM answers for a user, role or instance profile that doesn't exist.
 */
const NO_SUCH_ENTITY = "NoSuchEntity"

/**
 * Runs one `aws` request and answers its JSON output, or null when the request prints none.
 */
export async function aws<T>(caller: AWSCaller, args: readonly string[]): Promise<T | null> {
	const profile = caller && "profile" in caller ? ["--profile", caller.profile] : []

	// `execFile`'s `env` replaces the inherited environment, so a key extends a copy of it.
	// The copy drops the shell's session token and profile.
	// Either would otherwise outrank the key.
	// An empty value fails instead: `aws` reads `AWS_PROFILE=""` as the profile "", which no config holds.
	const options =
		caller && "key" in caller
			? {
					env: {
						...Object.fromEntries(
							// oxlint-disable-next-line sister-software/no-process-globals -- the child must inherit the path and the rest. No typed helper exposes the whole environment.
							Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.has(name))
						),
						AWS_ACCESS_KEY_ID: caller.key.accessKeyID,
						AWS_SECRET_ACCESS_KEY: caller.key.secretAccessKey,
					},
					maxBuffer: 64 * 1024 * 1024,
				}
			: { maxBuffer: 64 * 1024 * 1024 }

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
export async function readEntity<T>(caller: AWSCaller, args: readonly string[]): Promise<T | null> {
	try {
		return await aws<T>(caller, args)
	} catch (error) {
		if (isProcessError(error) && String(error.stderr).includes(NO_SUCH_ENTITY)) return null

		throw error
	}
}

export interface CallerIdentity {
	Account: string
	Arn: string
}

/**
 * The account and identity a caller's requests run as.
 */
export async function callerIdentity(caller: AWSCaller): Promise<CallerIdentity> {
	const identity = await aws<CallerIdentity>(caller, ["sts", "get-caller-identity"])

	if (!identity) throw new Error("aws sts get-caller-identity printed no identity")

	return identity
}

/**
 * The tile-build role's access key from the environment, or null when either half is unset.
 */
export function tileBuildKey(): AccessKey | null {
	const accessKeyID = $private.AWS_TILE_BUILD_ACCESS_KEY_ID
	const secretAccessKey = $private.AWS_TILE_BUILD_SECRET_ACCESS_KEY

	return accessKeyID && secretAccessKey ? { accessKeyID, secretAccessKey } : null
}
