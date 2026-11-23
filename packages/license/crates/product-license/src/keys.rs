// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Ed25519 keys as the TypeScript side writes them: spki PEM for a public key and PKCS8 PEM for a private
//! one, and the trust register both sides read.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The register `@mailwoman/license/product/trust` reads, embedded at build time so a trainer image carries the
/// keys of the source it was built from.
const TRUST_REGISTER: &str = include_str!("../../../lib/product/trust-register.json");

/// The spki DER header of an Ed25519 public key; the 32-byte point follows it.
const SPKI_HEADER: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// The PKCS8 v1 DER header of an Ed25519 private key; the 32-byte seed follows it.
const PKCS8_HEADER: [u8; 16] = [
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

fn pem_body(pem: &str, label: &str) -> Result<Vec<u8>, String> {
	let begin = format!("-----BEGIN {label}-----");
	let end = format!("-----END {label}-----");
	let start = pem.find(&begin).ok_or_else(|| format!("not a {label} PEM"))? + begin.len();
	let stop = pem[start..]
		.find(&end)
		.ok_or_else(|| format!("{label} PEM has no end line"))?
		+ start;
	let base64: String = pem[start..stop].chars().filter(|c| !c.is_whitespace()).collect();
	STANDARD.decode(base64).map_err(|e| format!("{label} PEM body: {e}"))
}

/// Reads an spki PEM Ed25519 public key.
pub fn public_key_from_pem(pem: &str) -> Result<VerifyingKey, String> {
	let der = pem_body(pem, "PUBLIC KEY")?;
	let point = der
		.strip_prefix(&SPKI_HEADER)
		.filter(|p| p.len() == 32)
		.ok_or("the public key is not an Ed25519 spki key")?;
	VerifyingKey::from_bytes(point.try_into().expect("32 bytes")).map_err(|e| format!("the public key: {e}"))
}

/// Reads a PKCS8 PEM Ed25519 private key, the form `generateLicenseSigningKeyPair` writes.
pub fn signing_key_from_pem(pem: &str) -> Result<SigningKey, String> {
	let der = pem_body(pem, "PRIVATE KEY")?;
	let seed = der
		.strip_prefix(&PKCS8_HEADER)
		.filter(|s| s.len() == 32)
		.ok_or("the private key is not an Ed25519 PKCS8 key")?;
	Ok(SigningKey::from_bytes(seed.try_into().expect("32 bytes")))
}

/// The eight hex digits a key id carries after its use letter and major version: the first four bytes of the
/// sha256 of the key's spki DER, as `licenseKeyID` derives them.
pub fn key_digest(key: &VerifyingKey) -> String {
	let mut der = SPKI_HEADER.to_vec();
	der.extend_from_slice(key.as_bytes());
	Sha256::digest(&der)[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// Key id → public key for offline verification.
#[derive(Clone, Debug, Default)]
pub struct TrustMap(BTreeMap<String, VerifyingKey>);

impl TrustMap {
	/// A trust map from key id → spki PEM pairs, the shape the shared fixtures carry.
	pub fn from_pems<'a>(pems: impl IntoIterator<Item = (&'a str, &'a str)>) -> Result<Self, String> {
		pems.into_iter()
			.map(|(kid, pem)| Ok((kid.to_owned(), public_key_from_pem(pem)?)))
			.collect::<Result<BTreeMap<_, _>, String>>()
			.map(TrustMap)
	}

	pub fn get(&self, kid: &str) -> Option<&VerifyingKey> {
		self.0.get(kid)
	}

	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
}

#[derive(Deserialize)]
struct RegisterKey {
	kid: String,
	#[serde(rename = "publicKeyPEM")]
	public_key_pem: String,
	status: String,
}

#[derive(Deserialize)]
struct Register {
	format: String,
	license_keys: Vec<RegisterKey>,
	provenance_keys: Vec<RegisterKey>,
}

fn register() -> Register {
	let register: Register = serde_json::from_str(TRUST_REGISTER).expect("trust-register.json parses");
	assert_eq!(
		register.format, "mailwoman-trust-register/1",
		"trust-register.json format"
	);
	register
}

fn trusted(keys: &[RegisterKey]) -> TrustMap {
	TrustMap::from_pems(
		keys.iter()
			.filter(|k| k.status != "revoked")
			.map(|k| (k.kid.as_str(), k.public_key_pem.as_str())),
	)
	.expect("every trust-register.json key is an Ed25519 spki PEM")
}

/// The register's license keys that aren't revoked: they sign platform keys and training grants.
pub fn trusted_license_keys() -> TrustMap {
	trusted(&register().license_keys)
}

/// The register's provenance keys that aren't revoked: they sign model provenance manifests.
pub fn trusted_provenance_keys() -> TrustMap {
	trusted(&register().provenance_keys)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn every_register_key_id_is_the_digest_of_its_key() {
		let register = register();
		for key in register.license_keys.iter().chain(&register.provenance_keys) {
			let digest = key_digest(&public_key_from_pem(&key.public_key_pem).unwrap());
			assert!(key.kid.ends_with(&format!("-{digest}")), "{} vs {digest}", key.kid);
		}
		assert!(!trusted_license_keys().is_empty());
	}
}
