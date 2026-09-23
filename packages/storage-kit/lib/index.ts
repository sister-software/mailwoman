/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Storage operations for the data-root volume, surfaced through the private `mwops` CLI.
 */

export { claimFailures, inspectDevice, rootDeviceName, type BlockDevice, type DeviceClaim } from "#device"
export { enableUnmap, inspectDiscard, type DiscardSupport } from "#discard"
export { DEFAULT_MOUNT_OPTIONS, renderFstabEntry, spliceFstab, type FstabEntry } from "#fstab"
export { assertRoot, StorageEffect, type StorageContext, type StorageOperation } from "#operation"
export { renderSudoersRule, renderUdevRule } from "#host-rules"
export { findStorageOperation, storageOperations } from "#registry"
export { volumeSpec, type VolumeSpec } from "#volume"
