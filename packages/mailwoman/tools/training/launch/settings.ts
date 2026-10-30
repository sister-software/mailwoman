/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The configuration the training launcher reads, with one documented default per value. The variables and defaults
 *   are the ones `corpus-python/launch/settings.py` read, so a `.env` written for that launcher configures this one.
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
 * Credentials stay in the named Modal secrets, which the operator creates.
 */
export const LaunchEnvSchema = z.object({
	MAILWOMAN_MODAL_APP: text("mailwoman-training", "The Modal app the training sandboxes run under."),
	MAILWOMAN_MODAL_VOLUME: text("mailwoman-training", "The Modal volume that holds corpora, configs and run outputs."),
	MAILWOMAN_MODAL_TRAIN_GPU: text("A100-80GB", "The training GPU; `--gpu` overrides it per launch."),
	MAILWOMAN_MODAL_TRAIN_RETRIES: blankAsAbsent(z.coerce.number().int().min(0).default(3)).meta({
		description: "How often a sandbox restarts `trainer train` after a failed exit.",
	}),
	MAILWOMAN_MODAL_R2_SECRET: blankAsAbsent(z.string().optional()).meta({
		description: "The named Modal secret holding the RCLONE_S3_* keys, passed to every sandbox.",
	}),
})

/**
 * The launcher's live settings over the corpus package's public view, which holds
 * `MAILWOMAN_DATA_ROOT` and `MAILWOMAN_VOLUME_MOUNT`.
 */
export const launchSettings = liveEnv(LaunchEnvSchema, corpusPublic)
