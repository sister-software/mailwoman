// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `license` actions for commercial training: `grant-training`, `verify` on
 *   a training grant, `provenance` and `attest`.
 *
 *   `docs/engineering/reference/product-license-tokens.mdx` specifies the grant
 *   and the provenance manifest.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { encodeTrainingGrant, verifyTrainingGrant } from "@mailwoman/core/license"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { isoDate } from "@mailwoman/core/utils"
import { TRAINING_AGREEMENT_VERSION } from "@mailwoman/license/product/agreement"
import { trainingAdmission } from "@mailwoman/license/product/entitlement"
import {
	TRAINING_GRANT_ID_PATTERN,
	type TrainingGrantPayload,
	TrainingPermission,
} from "@mailwoman/license/product/token"
import { trustedLicenseSigningKeys, trustedProvenanceSigningKeys } from "@mailwoman/license/product/trust"

import {
	PROVENANCE_KEY_FILE,
	PROVENANCE_PUBLIC_KEY_FILE,
	PUBLIC_KEY_FILE,
	registeredSigningKey,
	SIGNING_KEY_FILE,
} from "#cli/native/commands/license/signing"
import { booleanValue, CLIError, CLIUsageError, type ParsedCommand, stringValue } from "#cli/native/spec"

/**
 * The longest a training grant runs from its issue date.
 *
 * Offline verification observes expiry only, so a revoked agreement stops admitting
 * new runs when its current grant expires.
 * Ninety-two days bounds that to one calendar quarter.
 * The issuer renews within the agreement's term.
 */
const TRAINING_GRANT_MAX_DAYS = 92

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * The random bytes of a new grant id: 24 hex digits.
 */
const GRANT_ID_BYTES = 12

function randomHex(bytes: number): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * `license grant-training`: a commercial training grant under a written training agreement.
 *
 * The negotiated issuance path.
 * It signs with the same private key custody as `issue`, and checkout and declarations never reach it.
 * A renewal passes `--grant` to keep the grant id.
 */
export async function grantTraining(parsed: ParsedCommand): Promise<number> {
	const holder = stringValue(parsed.values, "holder")
	const expires = stringValue(parsed.values, "expires")

	if (!holder || !expires)
		throw new CLIUsageError("grant-training requires --holder <party> and --expires <YYYY-MM-DD>.")

	const issued = isoDate()
	const days = (Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${issued}T00:00:00Z`)) / MILLISECONDS_PER_DAY

	if (!Number.isFinite(days) || days < 0 || days > TRAINING_GRANT_MAX_DAYS) {
		throw new CLIUsageError(
			`--expires must fall within ${TRAINING_GRANT_MAX_DAYS} days of today (${issued}). Renew within the agreement's term instead.`
		)
	}

	const permits = extractDelimited(stringValue(parsed.values, "permits") ?? "train,deploy")
	const unknown = permits.filter((p) => !Object.values(TrainingPermission).includes(p as TrainingPermission))

	if (unknown.length) throw new CLIUsageError(`--permits holds ${unknown.join(", ")}. Expected train and deploy.`)

	const signer = await registeredSigningKey(parsed, SIGNING_KEY_FILE, PUBLIC_KEY_FILE, trustedLicenseSigningKeys())
	const grant = stringValue(parsed.values, "grant") ?? `mtg_${randomHex(GRANT_ID_BYTES)}`

	if (!TRAINING_GRANT_ID_PATTERN.test(grant))
		throw new CLIUsageError("--grant must be mtg_ and 24 lowercase hex digits.")

	const payload: TrainingGrantPayload = {
		v: 1,
		kid: signer.kid,
		grant,
		holder,
		agreement: stringValue(parsed.values, "agreement") ?? TRAINING_AGREEMENT_VERSION,
		issued,
		expires,
		permits,
	}

	const token = await encodeTrainingGrant(payload, signer.privateKeyPEM)

	process.stdout.write(booleanValue(parsed.values, "json") ? prettyJSON({ token, payload }) : `${token}\n`)

	return 0
}

/**
 * `license verify` on a training grant: the verification and whether it admits a commercial training run.
 *
 * The output holds the grant's claims and never the token.
 */
export async function reportTrainingGrant(parsed: ParsedCommand, token: string): Promise<number> {
	const verification = await verifyTrainingGrant(token, { trustedKeys: trustedLicenseSigningKeys() })
	const admission = trainingAdmission(verification)

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(
			prettyJSON({
				...verification,
				training: admission.admitted ? "admitted" : admission.refusal,
				...(admission.admitted ? {} : { training_reason: admission.reason }),
			})
		)
	} else {
		const lines = [`status: ${verification.status}`]

		if ("payload" in verification) {
			lines.push(
				`grant: ${verification.payload.grant}`,
				`holder: ${verification.payload.holder}`,
				`agreement: ${verification.payload.agreement}`,
				`key id: ${verification.kid}`,
				`issued: ${verification.payload.issued}`,
				`expires: ${verification.payload.expires}`,
				`permits: ${verification.payload.permits.join(", ")}`
			)
		}

		if ("reason" in verification) {
			lines.push(`reason: ${verification.reason}`)
		}

		lines.push(`training: ${admission.admitted ? "admitted" : `refused (${admission.refusal}): ${admission.reason}`}`)

		process.stdout.write(`${lines.join("\n")}\n`)
	}

	return admission.admitted ? 0 : 1
}

/**
 * `license provenance --manifest <path>`: a model's provenance manifest,
 * verified against the files beside it.
 *
 * A verified manifest records the run that produced the model and the grant that admitted it.
 * It never stands in for a current grant, so the output states the grant's
 * recorded expiry beside the verification.
 */
export async function provenanceCommand(parsed: ParsedCommand): Promise<number> {
	const manifest = stringValue(parsed.values, "manifest")

	if (!manifest) throw new CLIUsageError("provenance needs --manifest <graph.provenance.json>.")

	const { verifyProvenanceManifest } = await import("@mailwoman/core/license/provenance")

	const result = await verifyProvenanceManifest(manifest, {
		requireSignature: booleanValue(parsed.values, "require-signature"),
	})

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(prettyJSON(result))
	} else if (result.status === "verified") {
		const { payload } = result
		const grant = payload.training?.grant

		process.stdout.write(
			[
				`status: verified (${payload.attestation}${result.kid ? `, key id ${result.kid}` : ""})`,
				`provenance id: ${payload.provenance_id}`,
				`artifacts: ${payload.artifacts.map((a) => a.path).join(", ")}`,
				`training: ${payload.training ? `${payload.training.license_branch} run ${payload.training.run_id}` : "none recorded"}`,
				...(grant ? [`grant: ${grant.grant} under ${grant.agreement}, recorded expiry ${grant.expires}`] : []),
				...(payload.parent ? [`parent: ${payload.parent.provenance_id} (${payload.parent.transformation})`] : []),
				"",
			].join("\n")
		)
	} else {
		process.stdout.write(`status: refused (${result.refusal})\nreason: ${result.reason}\n`)
	}

	return result.status === "verified" ? 0 : 1
}

/**
 * `license attest --manifest <submitted> --out <path>`: the issuer's signature
 * over a customer-submitted model.
 *
 * Sister Software didn't run a customer-controlled training or export, so it attests
 * only to what it verified: the submitted files match the submitted digests.
 * The training record stays the customer's claim, and the `customer-submitted` attestation records that.
 */
export async function attestCommand(parsed: ParsedCommand): Promise<number> {
	const manifest = stringValue(parsed.values, "manifest")
	const out = stringValue(parsed.values, "out")

	if (!manifest || !out) throw new CLIUsageError("attest needs --manifest <submitted manifest> and --out <path>.")

	const { encodeProvenanceManifest, verifyProvenanceManifest } = await import("@mailwoman/core/license/provenance")
	const submitted = await verifyProvenanceManifest(manifest, { trustedKeys: trustedProvenanceSigningKeys() })

	if (submitted.status !== "verified") {
		throw new CLIError(`Not attested: ${submitted.refusal}: ${submitted.reason}`)
	}

	const signer = await registeredSigningKey(
		parsed,
		PROVENANCE_KEY_FILE,
		PROVENANCE_PUBLIC_KEY_FILE,
		trustedProvenanceSigningKeys()
	)

	const attested = await encodeProvenanceManifest(
		{ ...submitted.payload, attestation: "customer-submitted" },
		{ kid: signer.kid, privateKeyPEM: signer.privateKeyPEM }
	)

	await writeLocalTextFile(prettyJSON(attested), out)
	process.stdout.write(`wrote ${out} (customer-submitted, key id ${signer.kid})\n`)

	return 0
}
