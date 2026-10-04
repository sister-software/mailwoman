// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Storage operations for the data-root volume, surfaced through the private `mwops` CLI.
 */

export { claimFailures, inspectDevice, rootDeviceName, type BlockDevice, type DeviceClaim } from "#storage-kit/device"
export { enableUnmap, inspectDiscard, type DiscardSupport } from "#storage-kit/discard"
export { DEFAULT_MOUNT_OPTIONS, renderFstabEntry, spliceFstab, type FstabEntry } from "#storage-kit/fstab"
export { assertRoot, StorageEffect, type StorageContext, type StorageOperation } from "#storage-kit/operation"
export { renderSudoersRule, renderUdevRule } from "#storage-kit/host-rules"
export { findStorageOperation, storageOperations } from "#storage-kit/registry"
export { volumeSpec, type VolumeSpec } from "#storage-kit/volume"
