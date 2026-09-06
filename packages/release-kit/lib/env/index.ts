/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, $public as corePublic, liveEnv } from "@mailwoman/core/env"

import { PrivateReleaseEnvSchema, PublicReleaseEnvSchema } from "./schema.ts"

/**
 * Live core and release settings, sharing core's getters and cached values.
 */
export const $public = liveEnv(PublicReleaseEnvSchema, corePublic)

/**
 * Live core and release credentials, sharing core's getters and cached values. Never log their values.
 */
export const $private = liveEnv(PrivateReleaseEnvSchema, corePrivate)
