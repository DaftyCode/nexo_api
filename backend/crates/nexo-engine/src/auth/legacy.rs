//! Hashes and ciphers that legacy protocols require and aws-lc-rs does not offer (MD4, MD5,
//! HMAC-MD5, DES), from the AWS-LC C library under it: no other crypto crate is needed.
//! Only NTLM and Digest use them, because their specifications do.
use aws_lc_sys as ffi;

pub fn md4(data: &[u8]) -> [u8; 16] {
    let mut out = [0u8; 16];
    // SAFETY: `data` is valid for `data.len()` bytes and `out` has room for an MD4 digest.
    unsafe { ffi::MD4(data.as_ptr(), data.len(), out.as_mut_ptr()) };
    out
}

pub fn md5(data: &[u8]) -> [u8; 16] {
    let mut out = [0u8; 16];
    // SAFETY: as in `md4`, with room for an MD5 digest.
    unsafe { ffi::MD5(data.as_ptr(), data.len(), out.as_mut_ptr()) };
    out
}

pub fn hmac_md5(key: &[u8], data: &[u8]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut length = 0u32;
    // SAFETY: the key and data are valid for their lengths, `out` has room for an MD5 digest,
    // and `EVP_md5` returns a static digest.
    unsafe {
        ffi::HMAC(
            ffi::EVP_md5(),
            key.as_ptr().cast(),
            key.len(),
            data.as_ptr(),
            data.len(),
            out.as_mut_ptr(),
            &mut length,
        )
    };
    out
}

/// DES-encrypts one block with a 7-byte key, spread over 8 bytes as [MS-NLMP] does.
pub fn des(key: &[u8], block: &[u8]) -> [u8; 8] {
    let mut bits = 0u64;
    for byte in key.iter().take(7) {
        bits = (bits << 8) | u64::from(*byte);
    }
    let mut spread = ffi::DES_cblock { bytes: [0; 8] };
    for (index, byte) in spread.bytes.iter_mut().enumerate() {
        *byte = (((bits >> (49 - 7 * index)) & 0x7F) as u8) << 1;
    }
    let mut input = ffi::DES_cblock { bytes: [0; 8] };
    input.bytes.copy_from_slice(&block[..8]);
    let mut output = ffi::DES_cblock { bytes: [0; 8] };
    let mut schedule = ffi::DES_key_schedule::default();
    // SAFETY: every pointer refers to a live, correctly sized value on this stack frame.
    unsafe {
        ffi::DES_set_key_unchecked(&spread, &mut schedule);
        ffi::DES_ecb_encrypt(&input, &mut output, &schedule, ffi::DES_ENCRYPT);
    }
    output.bytes
}
