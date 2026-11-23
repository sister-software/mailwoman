// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the shared product-license fixtures that the TypeScript and Rust verifiers both read:
 *   `packages/license/test/fixtures/product/tokens.json` and the `provenance/` directory beside it.
 *
 *   The signing keys come from `keys.json` in the same directory.
 *   It holds test keys no production register lists.
 *
 *   Each case states the result the format specification
 *   (`docs/engineering/reference/product-license-tokens.mdx`) requires,
 *   so a verifier that disagrees with a case is the one to fix.
 *
 *   Ed25519 signing is deterministic, so a rerun reproduces every file byte for byte.
 *
 *   Usage: node packages/core/tools/license/product-fixtures.run.ts [--check]
 *
 *   `--check` compares instead of writing, and exits 1 when a committed fixture
 *   differs from what the run would write.
 */

import type { ProvenancePayload, TrainingRecord } from "@mailwoman/license/product/provenance"
import type { LicenseKeyPayload, TrainingGrantPayload } from "@mailwoman/license/product/token"

import { toBase64URL, utf8Bytes } from "#crypto/base64url"
import { signEd25519 } from "#crypto/ed25519"
import { readLocalJSONFile, readLocalTextFile } from "#fs/readers"
import { pathExists } from "#fs/readers/stat"
import { writeLocalTextFile } from "#fs/writers"
import { sha256Hex } from "#hash"
import { prettyJSON, stringifyJSON } from "#json"
import { encodeLicenseKey, encodeTrainingGrant } from "#license/key"
import { encodeProvenanceManifest } from "#license/provenance"
import { resolvePackagePath } from "#module/resolvers"
import { parseArguments } from "#scripting/arguments"

interface FixtureKey {
	kid: string
	privateKeyPEM: string
	publicKeyPEM: string
}

interface FixtureKeys {
	license: FixtureKey
	provenance: FixtureKey
	untrusted: FixtureKey
}

/**
 * The result each verifier must return for a case.
 *
 * `license_key` and `training_grant` are the statuses of the `mwl1` and `mwt1` verifiers,
 * and `training` is the training entitlement check's `admitted` or refusal code.
 */
interface TokenExpectation {
	license_key: "valid" | "expired" | "unknown_key" | "invalid"
	training_grant: "valid" | "expired" | "unknown_key" | "invalid"
	training: string
}

interface TokenCase {
	name: string
	token: string | null
	now: string
	expect: TokenExpectation
}

const fixtureDirectory = resolvePackagePath("@mailwoman/license", "test", "fixtures", "product")

const keys = await readLocalJSONFile<FixtureKeys>(
	resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "keys.json")
)

const legacy = await readLocalJSONFile<{ token: string; kid: string; publicKeyPEM: string }>(
	resolvePackagePath("@mailwoman/core", "test", "fixtures", "license", "legacy-token.json")
)

const grant: TrainingGrantPayload = {
	v: 1,
	kid: keys.license.kid,
	grant: "mtg_0123456789abcdef01234567",
	holder: "Fixture Training Customer Ltd",
	agreement: "commercial-training-2026-11",
	issued: "2026-11-01",
	expires: "2027-01-31",
	permits: ["train", "deploy"],
}

const platform: LicenseKeyPayload = {
	v: 1,
	kid: keys.license.kid,
	licensee: "Fixture Platform Customer Ltd",
	issued: "2026-11-01",
	expires: "2027-01-31",
	scope: "all",
	terms: "LicenseRef-Commercial",
	lid: "lic_0123456789abcdefghijkl",
	agreement: "commercial-2026-11",
	intent: "commercial",
	seq: 1,
}

const declaration: LicenseKeyPayload = {
	v: 1,
	kid: keys.license.kid,
	licensee: "Fixture Declarant",
	issued: "2026-11-01",
	expires: "2027-03-11",
	scope: "all",
	terms: "AGPL-3.0-only",
	lid: "lic_abcdefghijkl0123456789",
	intent: "open-source",
	seq: 2,
	install: "6f1e2a4c-9b3d-4e8f-a1c2-0d5e6f7a8b9c",
}

const evaluation: LicenseKeyPayload = {
	...declaration,
	licensee: "Fixture Evaluator",
	expires: "2026-12-01",
	terms: "LicenseRef-Commercial",
	intent: "evaluation",
	seq: 1,
}

const DURING = "2026-12-01T00:00:00.000Z"

const validGrant = await encodeTrainingGrant(grant, keys.license.privateKeyPEM)
const [grantPrefix, grantPayload, grantSignature] = validGrant.split(".") as [string, string, string]
const platformKey = await encodeLicenseKey(platform, keys.license.privateKeyPEM)
const [, platformPayload, platformSignature] = platformKey.split(".") as [string, string, string]

/**
 * A payload part encoding arbitrary JSON text, for cases whose signature never gets checked.
 */
function payloadOf(json: string): string {
	return toBase64URL(utf8Bytes(json))
}

const NOT_TRAINING = { license_key: "valid", training_grant: "invalid", training: "not_a_training_grant" } as const

const cases: TokenCase[] = [
	{
		name: "an active training grant admits a run",
		token: validGrant,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "valid", training: "admitted" },
	},
	{
		name: "a training grant is valid at the last millisecond of its expiry date in UTC",
		token: validGrant,
		now: "2027-01-31T23:59:59.999Z",
		expect: { license_key: "invalid", training_grant: "valid", training: "admitted" },
	},
	{
		name: "a training grant is expired one millisecond after its expiry date ends in UTC",
		token: validGrant,
		now: "2027-02-01T00:00:00.000Z",
		expect: { license_key: "invalid", training_grant: "expired", training: "expired" },
	},
	{
		name: "a grant that permits only deploy refuses training",
		token: await encodeTrainingGrant({ ...grant, permits: ["deploy"] }, keys.license.privateKeyPEM),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "valid", training: "not_permitted" },
	},
	{
		name: "a permission this verifier doesn't know grants nothing",
		token: await encodeTrainingGrant({ ...grant, permits: ["train-everything"] }, keys.license.privateKeyPEM),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "valid", training: "not_permitted" },
	},
	{
		name: "a field the schema doesn't define is ignored",
		token: await encodeTrainingGrant({ ...grant, note: "ignored" } as TrainingGrantPayload, keys.license.privateKeyPEM),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "valid", training: "admitted" },
	},
	{
		name: "a purchased platform key with scope all is no training grant",
		token: platformKey,
		now: DURING,
		expect: NOT_TRAINING,
	},
	{
		name: "an open-source declaration with scope all is no training grant",
		token: await encodeLicenseKey(declaration, keys.license.privateKeyPEM),
		now: DURING,
		expect: NOT_TRAINING,
	},
	{
		name: "an evaluation key is no training grant",
		token: await encodeLicenseKey(evaluation, keys.license.privateKeyPEM),
		now: "2026-11-15T00:00:00.000Z",
		expect: NOT_TRAINING,
	},
	{
		name: "the legacy node:crypto platform key verifies and is no training grant",
		token: legacy.token,
		now: DURING,
		expect: NOT_TRAINING,
	},
	{
		name: "an expired platform key is expired and is no training grant",
		token: platformKey,
		now: "2027-02-01T00:00:00.000Z",
		expect: { license_key: "expired", training_grant: "invalid", training: "not_a_training_grant" },
	},
	{
		name: "a training grant from a signer the register doesn't hold",
		token: await encodeTrainingGrant({ ...grant, kid: keys.untrusted.kid }, keys.untrusted.privateKeyPEM),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "unknown_key", training: "unknown_key" },
	},
	{
		name: "an altered payload fails the signature",
		token: `${grantPrefix}.${payloadOf(stringifyJSON({ ...grant, holder: "Someone Else" }))}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "an extended expiry fails the signature",
		token: `${grantPrefix}.${payloadOf(stringifyJSON({ ...grant, expires: "2099-12-31" }))}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a platform payload relabeled as a training grant fails",
		token: `${grantPrefix}.${platformPayload}.${platformSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a grant payload relabeled as a platform key fails",
		token: `mwl1.${grantPayload}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "not_a_training_grant" },
	},
	{
		name: "a grant ID outside the mtg_ shape is invalid",
		token: await encodeTrainingGrantUnchecked({ ...grant, grant: "grant-1" }),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a grant without an expiry is invalid",
		token: await encodeTrainingGrantUnchecked({ ...grant, expires: undefined }),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "an expiry date that names no real day is invalid",
		token: await encodeTrainingGrantUnchecked({ ...grant, expires: "2027-02-30" }),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "an expiry month outside 01 to 12 is invalid",
		token: await encodeTrainingGrantUnchecked({ ...grant, expires: "2027-13-01" }),
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a token with two parts is malformed",
		token: `${grantPrefix}.${grantPayload}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a payload outside the base64url alphabet is malformed",
		token: `${grantPrefix}.${grantPayload.slice(0, 8)}+/${grantPayload.slice(8)}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a payload that isn't JSON is malformed",
		token: `${grantPrefix}.${payloadOf("not json")}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a payload that isn't UTF-8 is malformed",
		token: `${grantPrefix}.${toBase64URL(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a truncated signature fails",
		token: `${grantPrefix}.${grantPayload}.${grantSignature.slice(0, 40)}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "an unknown token prefix is malformed",
		token: `mwl9.${grantPayload}.${grantSignature}`,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "invalid" },
	},
	{
		name: "a missing credential grants nothing",
		token: null,
		now: DURING,
		expect: { license_key: "invalid", training_grant: "invalid", training: "missing" },
	},
]

/**
 * Signs a payload the schema refuses, for the cases that test the verifier's schema check.
 */
async function encodeTrainingGrantUnchecked(payload: Record<string, unknown>): Promise<string> {
	const body = `mwt1.${toBase64URL(utf8Bytes(stringifyJSON(payload)))}`

	return `${body}.${toBase64URL(await signEd25519(utf8Bytes(body), keys.license.privateKeyPEM))}`
}

const tokens = {
	$comment:
		"Generated by packages/core/tools/license/product-fixtures.run.ts from keys.json; regenerate rather than edit. Each case states the statuses docs/engineering/reference/product-license-tokens.mdx requires of both verifiers.",
	trusted_license_keys: { [keys.license.kid]: keys.license.publicKeyPEM, [legacy.kid]: legacy.publicKeyPEM },
	cases,
}

const record: TrainingRecord = {
	format: "mailwoman-training-record/1",
	run_id: "mwrun_00112233445566778899aabb",
	license_branch: "LicenseRef-Commercial",
	grant: { grant: grant.grant, agreement: grant.agreement, kid: grant.kid, expires: grant.expires },
	trainer: { version: "0.1.0", build: "commercial", image: "mailwoman-trainer-cu130-1.99.1-0123456789abcdef" },
	resolved_config_sha256: "a".repeat(64),
	corpus_manifest_sha256: "b".repeat(64),
	parent: null,
	verifications: [
		{
			event: "start",
			at: "2026-11-02T10:00:00Z",
			grant: { grant: grant.grant, agreement: grant.agreement, kid: grant.kid, expires: grant.expires },
		},
	],
}

const sidecars: Record<string, string> = {
	"model.onnx": "a stand-in for an ONNX graph: the manifest binds bytes, whatever they encode\n",
	"CORPUS.json": prettyJSON({ corpus_dir: "/data/corpus", manifest_sha256: "b".repeat(64), corpus_version: "fixture" }),
	"TRAINING.json": prettyJSON(record),
}

const outputs = new Map<string, string>([
	[
		resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "tokens.json").toString(),
		prettyJSON(tokens),
	],
])

for (const [name, contents] of Object.entries(sidecars)) {
	outputs.set(
		resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "provenance", name).toString(),
		contents
	)
}

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const payload: ProvenancePayload = {
	v: 1,
	provenance_id: "mwprov_00112233445566778899aabb",
	created: "2026-11-03T12:00:00Z",
	attestation: "managed",
	// The digests of the bytes this run writes, so a check run needs no file on disk.
	artifacts: Object.entries(sidecars).map(([path, contents]) => {
		const bytes = utf8Bytes(contents)

		return { path, sha256: sha256Hex(bytes), bytes: bytes.length }
	}),
	training: record,
	parent: null,
}

const manifests = {
	"model.provenance.json": await encodeProvenanceManifest(payload, keys.provenance),
	"license-key-signed.provenance.json": await encodeProvenanceManifest(payload, keys.license),
	"unattested.provenance.json": await encodeProvenanceManifest({ ...payload, attestation: "unattested" }, null),
}

for (const [name, manifest] of Object.entries(manifests)) {
	outputs.set(
		resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "provenance", name).toString(),
		prettyJSON(manifest)
	)
}

const provenanceCases = {
	$comment:
		"Generated by packages/core/tools/license/product-fixtures.run.ts. Each case verifies a manifest in provenance/ against trusted_provenance_keys and states the result both verifiers must return.",
	trusted_provenance_keys: { [keys.provenance.kid]: keys.provenance.publicKeyPEM },
	cases: [
		{
			name: "a managed manifest signed by a provenance key verifies",
			manifest: "model.provenance.json",
			require_signature: true,
			expect: "verified",
		},
		{
			name: "a manifest signed by a license key is refused",
			manifest: "license-key-signed.provenance.json",
			require_signature: true,
			expect: "unknown_key",
		},
		{
			name: "an unattested manifest verifies its digests when no signature is required",
			manifest: "unattested.provenance.json",
			require_signature: false,
			expect: "verified",
		},
		{
			name: "an unattested manifest is refused where a signature is required",
			manifest: "unattested.provenance.json",
			require_signature: true,
			expect: "unsigned",
		},
	],
}

outputs.set(
	resolvePackagePath("@mailwoman/license", "test", "fixtures", "product", "provenance.json").toString(),
	prettyJSON(provenanceCases)
)

let stale = 0

for (const [path, contents] of outputs) {
	if (values.check) {
		const committed = (await pathExists(path)) ? await readLocalTextFile(path) : null

		if (committed !== contents) {
			console.error(`stale: ${path}`)

			stale++
		}
	} else {
		await writeLocalTextFile(contents, path)
	}
}

console.log(`${values.check ? "checked" : "wrote"} ${outputs.size} fixture files under ${fixtureDirectory}`)

if (stale) {
	process.exit(1)
}
