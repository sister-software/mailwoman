// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The configuration the training launcher reads, with one documented default per value.
 *
 *   The variables and defaults are the ones the retired Python launcher read,
 *   so a `.env` written for that launcher configures this one.
 */

import { liveEnv } from "@mailwoman/core/env"
import { blankAsAbsent } from "@mailwoman/core/env/utils"
import { $public as corpusPublic } from "@mailwoman/corpus/env"
import { z } from "zod"

const text = (fallback: string, description: string) =>
	blankAsAbsent(z.string().default(fallback)).meta({ description })

/**
 * The launcher's variables.
 *
 * Credentials stay in Modal secrets that the operator creates by name.
 */
export const LaunchEnvSchema = z.object({
	MAILWOMAN_MODAL_APP: text("mailwoman-training", "The Modal app the training sandboxes run under."),
	MAILWOMAN_MODAL_VOLUME: text("mailwoman-training", "The Modal volume that holds corpora, configs and run outputs."),
	MAILWOMAN_MODAL_TRAIN_GPU: text("A100-40GB", "The training GPU; `--device` overrides it per launch."),
	MAILWOMAN_R2_BUCKET: text("mailwoman-assets", "The R2 bucket `sync` stages corpora from."),
	MAILWOMAN_MODAL_TRAIN_RETRIES: blankAsAbsent(z.coerce.number().int().min(0).default(3)).meta({
		description: "How often a sandbox restarts `trainer train` after a failed exit.",
	}),
	MAILWOMAN_MODAL_R2_SECRET: blankAsAbsent(z.string().optional()).meta({
		description: "The named Modal secret holding the RCLONE_S3_* keys, passed to every sandbox.",
	}),
	MAILWOMAN_MODAL_TRAINING_SECRET: blankAsAbsent(z.string().optional()).meta({
		description:
			"The named Modal secret holding MAILWOMAN_TRAINING_GRANT, the mwt1 training grant a commercial launch's sandbox verifies. " +
			"Create it with `modal secret create --from-dotenv <env file> <name>`. The launch records the name, never the token.",
	}),
	MAILWOMAN_MODAL_PROVENANCE_SECRET: blankAsAbsent(z.string().optional()).meta({
		description:
			"The named Modal secret holding MAILWOMAN_PROVENANCE_SIGNING_KEY and MAILWOMAN_PROVENANCE_SIGNING_KID. " +
			"A commercial launch's sandbox signs the provenance manifest of the model it exports with it.",
	}),
	MAILWOMAN_TRAINING_GRANT: blankAsAbsent(z.string().optional()).meta({
		description:
			"A training grant held on the host. A commercial launch verifies it before it starts a sandbox and refuses one that doesn't admit the run; " +
			"the sandbox reads its own copy from the named training secret.",
	}),
})

/**
 * The launcher's live settings override the corpus package's public view.
 *
 * That view holds `MAILWOMAN_DATA_ROOT` and `MAILWOMAN_VOLUME_MOUNT`.
 */
export const launchSettings = liveEnv(LaunchEnvSchema, corpusPublic)
