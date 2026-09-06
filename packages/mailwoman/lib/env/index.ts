/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, $public as corePublic, liveEnv } from "@mailwoman/core/env"

import { PrivateEvaluationEnvSchema, PublicEvaluationEnvSchema } from "./schema.ts"

/**
 * Live core and evaluation settings, sharing core's getters and cached values.
 */
export const $public = liveEnv(PublicEvaluationEnvSchema, corePublic)

/**
 * Live core and evaluation secrets, sharing core's getters and cached values. Never log their values.
 */
export const $private = liveEnv(PrivateEvaluationEnvSchema, corePrivate)
