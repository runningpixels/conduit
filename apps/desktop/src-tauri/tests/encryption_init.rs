//! M6: encryption primitive — Off identity, On round-trip, blob encode/decode.

mod common;

use conduit_desktop::encryption::{self, Encryption, EncryptionTier};

#[test]
fn off_is_identity() {
    let enc = Encryption::off();
    assert_eq!(enc.tier(), EncryptionTier::Off);
    assert!(!enc.is_on());

    // encrypt/decrypt are plaintext passthrough (no prefix).
    let ct = enc.encrypt("hello world").unwrap();
    assert_eq!(ct, "hello world");
    assert_eq!(enc.decrypt("hello world").unwrap(), "hello world");

    // Options: None stays None; Some passes through.
    assert_eq!(enc.encrypt_opt(None).unwrap(), None);
    assert_eq!(enc.encrypt_opt(Some("x")).unwrap().as_deref(), Some("x"));
    assert_eq!(enc.decrypt_opt(None).unwrap(), None);
    assert_eq!(enc.decrypt_opt(Some("x")).unwrap().as_deref(), Some("x"));

    // Off blobs are byte-identical to plaintext.
    let bytes = b"raw blob bytes".to_vec();
    assert_eq!(enc.encode_blob(&bytes).unwrap(), bytes);
    assert_eq!(enc.decode_blob(&bytes).unwrap(), bytes);
}

#[test]
fn on_encrypts_and_round_trips() {
    let enc = Encryption::on_with_key(encryption::generate_key(), 1);
    assert_eq!(enc.tier(), EncryptionTier::On);
    assert!(enc.is_on());
    assert_eq!(enc.key_version(), 1);

    let plaintext = "sensitive chat content — üñîçødé";
    let ct = enc.encrypt(plaintext).unwrap();
    assert_ne!(ct, plaintext, "ciphertext differs from plaintext");
    assert!(
        ct.starts_with("enc:v1:"),
        "encrypted values carry the version prefix"
    );
    assert_eq!(enc.decrypt(&ct).unwrap(), plaintext, "round-trip restores plaintext");

    // Two encryptions of the same plaintext differ (random nonce).
    assert_ne!(enc.encrypt(plaintext).unwrap(), ct);

    // decrypt tolerates plaintext (no prefix) even when tier is On — this is
    // what lets the tier flip be non-destructive over a mixed store.
    assert_eq!(enc.decrypt("legacy plaintext").unwrap(), "legacy plaintext");
}

#[test]
fn on_blob_round_trips_and_is_not_plaintext() {
    let enc = Encryption::on_with_key(encryption::generate_key(), 1);
    let bytes = b"attachment payload \x00\x01 binary".to_vec();
    let on_disk = enc.encode_blob(&bytes).unwrap();
    assert_ne!(on_disk, bytes, "on-disk blob is not the plaintext");
    assert_eq!(&on_disk[..6], b"CDENC1", "encrypted blob carries the magic");
    assert_eq!(enc.decode_blob(&on_disk).unwrap(), bytes, "round-trip restores plaintext");

    // decode_blob tolerates a plaintext (magic-less) blob under On.
    assert_eq!(enc.decode_blob(b"plain").unwrap(), b"plain".to_vec());
}

#[test]
fn on_decrypt_with_wrong_key_fails() {
    let enc_a = Encryption::on_with_key(encryption::generate_key(), 1);
    let enc_b = Encryption::on_with_key(encryption::generate_key(), 1);
    let ct = enc_a.encrypt("secret").unwrap();
    // A different key cannot decrypt (AES-GCM tag check fails).
    assert!(enc_b.decrypt(&ct).is_err());
}