// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The training record a run writes and the signed provenance manifest an export writes beside a
 *   model.
 *
 *   A training grant is a bearer credential: it admits a run while it is valid and appears in no
 *   distributed file. The training record (`TRAINING.json`, written by the trainer beside a run's
 *   checkpoints) records the verified claims of the run: its ID, the license branch, the opaque grant
 *   ID, the agreement version and each verification. The provenance manifest (`<graph>.provenance.json`,
 *   written by `trainer-export` beside each graph) binds the final bytes of the graph and every sidecar a
 *   reader needs to interpret it to that record, and a provenance key signs it.
 *
 *   A manifest is a durable record of the artifact and the authorized run that produced it. An expired
 *   grant may appear in historical provenance. A manifest never stands in for a current grant.
 *
 *   The manifest's signature covers the ASCII bytes `mwp1.<payload>`, where `<payload>` is the unpadded
 *   base64url of the payload JSON exactly as the manifest stores it.
 */

import { z } from "zod"

/**
 * The prefix a provenance manifest's signature covers.
 */
export const PROVENANCE_PREFIX = "mwp1"

/**
 * The file name of a run's training record, beside its checkpoints.
 */
export const TRAINING_RECORD_FILE = "TRAINING.json"

/**
 * The suffix of a provenance manifest beside a graph: `model.onnx` → `model.provenance.json`.
 */
export const PROVENANCE_MANIFEST_SUFFIX = ".provenance.json"

/**
 * The ONNX metadata key whose value is the graph's provenance ID, for discovery.
 *
 * The manifest binds the graph: it hashes the graph's bytes, metadata included.
 * The metadata lets a reader find the manifest that describes the graph.
 */
export const PROVENANCE_METADATA_KEY = "mailwoman.provenance_id"

/**
 * The license branch a run trained under.
 */
export const TrainingBranch = {
	/**
	 * A build of the commercial trainer admitted the run under a training grant.
	 */
	Commercial: "LicenseRef-Commercial",
	/**
	 * The open-source trainer trained the run under the AGPL and checked no grant.
	 */
	OpenSource: "AGPL-3.0-only",
} as const

export type TrainingBranch = (typeof TrainingBranch)[keyof typeof TrainingBranch]

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u, "expected 64 lowercase hex digits")

const Instant = z.iso.datetime({ offset: false })

/**
 * The grant claims a training record stores: everything the verifier read except the holder's name.
 */
export const RecordedGrantSchema = z.object({
	grant: z.string().min(1),
	agreement: z.string().min(1),
	kid: z.string().min(1),
	expires: z.string().min(1),
})

export type RecordedGrant = z.infer<typeof RecordedGrantSchema>

/**
 * One authorization check the trainer ran: at the start of the run and at every resume.
 */
export const VerificationEventSchema = z.object({
	event: z.enum(["start", "resume"]),
	at: Instant,
	/**
	 * The grant that admitted this process, or `null` on the open-source branch.
	 */
	grant: RecordedGrantSchema.nullable(),
})

export type VerificationEvent = z.infer<typeof VerificationEventSchema>

/**
 * The checkpoint a run started from, when it didn't start from scratch.
 *
 * A branch from another run's checkpoint and a fine-tune from `train.init_from` are new runs with a parent.
 */
export const RunParentSchema = z.object({
	/**
	 * The parent run's ID, or `null` when the parent checkpoint has no training record.
	 */
	run_id: z.string().min(1).nullable(),
	/**
	 * The sha256 of the parent checkpoint's `model.safetensors`.
	 */
	model_sha256: SHA256,
})

/**
 * The schema of `TRAINING.json`.
 */
export const TrainingRecordSchema = z.object({
	format: z.literal("mailwoman-training-record/1"),
	/**
	 * `mwrun_` and 24 lowercase hex digits.
	 */
	run_id: z.string().regex(/^mwrun_[0-9a-f]{24}$/u),
	license_branch: z.enum([TrainingBranch.Commercial, TrainingBranch.OpenSource]),
	/**
	 * The grant that admitted the run's first process, or `null` on the open-source branch.
	 */
	grant: RecordedGrantSchema.nullable(),
	trainer: z.object({
		/**
		 * The `trainer-cli` crate version.
		 */
		version: z.string().min(1),
		build: z.enum(["commercial", "open-source"]),
		/**
		 * The published trainer image the launcher started, when the run ran in one.
		 */
		image: z.string().min(1).nullable(),
	}),
	resolved_config_sha256: SHA256,
	corpus_manifest_sha256: SHA256.nullable(),
	parent: RunParentSchema.nullable(),
	verifications: z.array(VerificationEventSchema).min(1),
})

export type TrainingRecord = z.infer<typeof TrainingRecordSchema>

/**
 * Who attests to a manifest.
 */
export const ProvenanceAttestation = {
	/**
	 * Sister Software ran the training and the export in the managed environment
	 * and signed the bytes it exported, with the provenance key held only in that environment.
	 */
	Managed: "managed",
	/**
	 * A customer trained and exported.
	 *
	 * The issuer verified the submitted bytes against the submitted digests
	 * and signed only that: the training record's claims are the customer's.
	 */
	CustomerSubmitted: "customer-submitted",
	/**
	 * No key signed the manifest.
	 * It records digests only.
	 */
	Unattested: "unattested",
} as const

export type ProvenanceAttestation = (typeof ProvenanceAttestation)[keyof typeof ProvenanceAttestation]

/**
 * One file the manifest binds, by its path relative to the manifest's directory.
 */
export const BoundArtifactSchema = z.object({
	path: z
		.string()
		.min(1)
		.refine(
			(path) => !path.startsWith("/") && !path.split("/").includes(".."),
			"a path inside the manifest's directory"
		),
	sha256: SHA256,
	bytes: z.number().int().min(0),
})

export type BoundArtifact = z.infer<typeof BoundArtifactSchema>

/**
 * The schema of a provenance manifest's payload.
 */
export const ProvenancePayloadSchema = z.object({
	v: z.literal(1),
	/**
	 * `mwprov_` and 24 lowercase hex digits.
	 * The graph's ONNX metadata repeats it.
	 */
	provenance_id: z.string().regex(/^mwprov_[0-9a-f]{24}$/u),
	created: Instant,
	attestation: z.enum([
		ProvenanceAttestation.Managed,
		ProvenanceAttestation.CustomerSubmitted,
		ProvenanceAttestation.Unattested,
	]),
	/**
	 * The graph first, then each sidecar.
	 */
	artifacts: z.array(BoundArtifactSchema).min(1),
	training: TrainingRecordSchema.nullable(),
	/**
	 * The manifest of the graph this one was derived from by a byte-changing transformation.
	 */
	parent: z
		.object({
			provenance_id: z.string().min(1),
			manifest_sha256: SHA256,
			transformation: z.enum(["quantize", "split-embeddings"]),
		})
		.nullable(),
})

export type ProvenancePayload = z.infer<typeof ProvenancePayloadSchema>

/**
 * The schema of a provenance manifest file.
 *
 * `kid` and `signature` are both present for a signed manifest and both `null` for an unattested one.
 */
export const ProvenanceManifestSchema = z.object({
	format: z.literal("mailwoman-model-provenance/1"),
	payload: z.string().regex(/^[A-Za-z0-9_-]+$/u),
	kid: z.string().min(1).nullable(),
	signature: z
		.string()
		.regex(/^[A-Za-z0-9_-]+$/u)
		.nullable(),
})

export type ProvenanceManifest = z.infer<typeof ProvenanceManifestSchema>

/**
 * Why a manifest failed verification.
 */
export const ProvenanceRefusal = {
	/**
	 * The manifest or its payload doesn't match its schema.
	 */
	Malformed: "malformed",
	/**
	 * No key signed the manifest, and the reader requires a signature.
	 */
	Unsigned: "unsigned",
	/**
	 * A provenance key this build doesn't trust signed it.
	 */
	UnknownKey: "unknown_key",
	/**
	 * The signature doesn't verify over the payload.
	 */
	BadSignature: "bad_signature",
	/**
	 * A bound file is missing, or its bytes differ from the recorded digest or length.
	 *
	 * A manifest moved beside another model fails here, because the other model's bytes hash differently.
	 */
	ArtifactMismatch: "artifact_mismatch",
} as const

export type ProvenanceRefusal = (typeof ProvenanceRefusal)[keyof typeof ProvenanceRefusal]

/**
 * The result of verifying a manifest against the files beside it.
 */
export type ProvenanceVerification =
	| { status: "verified"; kid: string | null; payload: ProvenancePayload }
	| { status: "refused"; refusal: ProvenanceRefusal; reason: string }
