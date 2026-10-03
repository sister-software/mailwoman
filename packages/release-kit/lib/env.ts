// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { $public as resolverPublic } from "@mailwoman/resolver-wof-sqlite/env"

import { PrivateReleaseEnvSchema, PublicReleaseEnvSchema } from "./env/schema.ts"

/**
 * Live release settings over the resolver's and core's (the development weights overlay
 * lives with the resolver), sharing their getters and cached values.
 */
export const $public = liveEnv(PublicReleaseEnvSchema, resolverPublic)

/**
 * Live release credentials over core's.
 *
 * Never log their values.
 */
export const $private = liveEnv(PrivateReleaseEnvSchema, corePrivate)
