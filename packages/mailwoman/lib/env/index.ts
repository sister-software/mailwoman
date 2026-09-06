/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { $public as resolverPublic } from "@mailwoman/resolver-wof-sqlite/env"

import { PrivateMailwomanEnvSchema, PublicMailwomanEnvSchema } from "./schema.ts"

export { PrivateMailwomanEnvSchema, PublicMailwomanEnvSchema } from "./schema.ts"

/**
 * Live settings for the CLI and runtime pipeline over the resolver's and core's, sharing their getters and cached
 * values.
 */
export const $public = liveEnv(PublicMailwomanEnvSchema, resolverPublic)

/**
 * Live secrets for the CLI's publishing and evaluation commands over core's. Never log their values.
 */
export const $private = liveEnv(PrivateMailwomanEnvSchema, corePrivate)
