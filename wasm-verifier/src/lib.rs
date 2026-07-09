// Portable WASM receipt verifier (proof-carrying E4, Stage 2).
//
// The integrity CORE of verifyReceiptArtifact, compiled to WebAssembly with no
// dependencies and no host trust: given the canonical receipt-body bytes and
// the claimed 32-byte artifact id, recompute SHA-256 over the body and return
// 1 iff it matches. A third party (a Worker, a browser, another org) can run
// this with only the artifact bytes — no producer code, no network, no DO.
//
// Pure no_std-style: a self-contained SHA-256, a fixed scratch buffer exported
// via memory, and two entrypoints. Deliberately tiny so the verifier is cheap
// and auditable — the whole point of Stage 2 is that trust rests on a small
// universal checker, not on trusting the producer.

#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! { loop {} }

// ---- SHA-256 (self-contained, no deps) ------------------------------------
const K: [u32; 64] = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];

fn sha256(msg: &[u8], out: &mut [u8; 32]) {
    let mut h: [u32; 8] = [
        0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,
    ];
    let ml = (msg.len() as u64) * 8;
    // Padded length: msg + 0x80 + zeros + 8-byte length, to a 64-byte multiple.
    let mut total = msg.len() + 1 + 8;
    if total % 64 != 0 { total += 64 - (total % 64); }
    let mut block = [0u8; 64];
    let mut i = 0usize;
    while i < total {
        // fill this 64-byte block
        let mut j = 0usize;
        while j < 64 {
            let pos = i + j;
            let b = if pos < msg.len() {
                msg[pos]
            } else if pos == msg.len() {
                0x80
            } else if pos >= total - 8 {
                let shift = (total - 1 - pos) * 8;
                ((ml >> shift) & 0xff) as u8
            } else {
                0
            };
            block[j] = b;
            j += 1;
        }
        // process block
        let mut w = [0u32; 64];
        let mut t = 0usize;
        while t < 16 {
            w[t] = ((block[t*4] as u32) << 24) | ((block[t*4+1] as u32) << 16)
                 | ((block[t*4+2] as u32) << 8) | (block[t*4+3] as u32);
            t += 1;
        }
        while t < 64 {
            let s0 = w[t-15].rotate_right(7) ^ w[t-15].rotate_right(18) ^ (w[t-15] >> 3);
            let s1 = w[t-2].rotate_right(17) ^ w[t-2].rotate_right(19) ^ (w[t-2] >> 10);
            w[t] = w[t-16].wrapping_add(s0).wrapping_add(w[t-7]).wrapping_add(s1);
            t += 1;
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7]);
        let mut r = 0usize;
        while r < 64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[r]).wrapping_add(w[r]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1);
            d = c; c = b; b = a; a = t1.wrapping_add(t2);
            r += 1;
        }
        h[0]=h[0].wrapping_add(a); h[1]=h[1].wrapping_add(b); h[2]=h[2].wrapping_add(c);
        h[3]=h[3].wrapping_add(d); h[4]=h[4].wrapping_add(e); h[5]=h[5].wrapping_add(f);
        h[6]=h[6].wrapping_add(g); h[7]=h[7].wrapping_add(hh);
        i += 64;
    }
    let mut k = 0usize;
    while k < 8 {
        out[k*4]   = (h[k] >> 24) as u8;
        out[k*4+1] = (h[k] >> 16) as u8;
        out[k*4+2] = (h[k] >> 8) as u8;
        out[k*4+3] = h[k] as u8;
        k += 1;
    }
}

// ---- Exported ABI ---------------------------------------------------------
// A fixed input buffer the host writes the canonical body bytes into, plus a
// 32-byte expected-id buffer. verify(len) returns 1 iff sha256(body) == id.
static mut BODY: [u8; 65536] = [0u8; 65536];
static mut EXPECTED: [u8; 32] = [0u8; 32];

#[no_mangle]
pub extern "C" fn body_ptr() -> *const u8 { core::ptr::addr_of!(BODY) as *const u8 }

#[no_mangle]
pub extern "C" fn body_cap() -> usize { 65536 }

#[no_mangle]
pub extern "C" fn expected_ptr() -> *const u8 { core::ptr::addr_of!(EXPECTED) as *const u8 }

/// Recompute SHA-256 over BODY[0..len] and compare to EXPECTED (32 bytes).
/// Returns 1 on match, 0 otherwise. Constant-work compare (no early exit).
#[no_mangle]
pub extern "C" fn verify(len: usize) -> i32 {
    if len > 65536 { return 0; }
    let mut digest = [0u8; 32];
    let body = unsafe { &*core::ptr::addr_of!(BODY) };
    sha256(&body[..len], &mut digest);
    let expected: &[u8; 32] = unsafe { &*core::ptr::addr_of!(EXPECTED) };
    let mut diff = 0u8;
    let mut i = 0usize;
    while i < 32 {
        diff |= digest[i] ^ expected[i];
        i += 1;
    }
    if diff == 0 { 1 } else { 0 }
}
