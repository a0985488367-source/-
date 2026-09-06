/**
 * hmac-sha256 — 純 JavaScript 實作
 *
 * 為什麼自己寫：Scriptable 沒有 WebCrypto，也沒有 Node 的 crypto 模組，
 * 但 Bybit V5 的私有端點需要 HMAC-SHA256 簽章。
 *
 * 以 RFC 4231 的標準測試向量驗證（見 tests/hmac-sha256.test.mjs）。
 *
 * 這個檔案只做雜湊運算，不接觸也不儲存任何金鑰。
 */

/* ------------------------------------------------------------------ */
/* SHA-256                                                             */
/* ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** @param {Uint8Array} bytes @returns {Uint8Array} 32 bytes */
export function sha256(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = bytes.length * 8;
  // 補位：0x80，然後補 0 到長度 ≡ 56 (mod 64)，最後 8 bytes 放位元長度
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // 位元長度以 64 位元大端寫入；這裡用 float 拆高低 32 位元以支援 >512MB 以外的一般情形
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, hi, false);
  dv.setUint32(padded.length - 4, lo, false);

  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) odv.setUint32(i * 4, H[i], false);
  return out;
}

/* ------------------------------------------------------------------ */
/* 編碼輔助                                                             */
/* ------------------------------------------------------------------ */

/** UTF-8 編碼，不依賴 TextEncoder（Scriptable 環境不保證有） */
export function utf8Bytes(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex) {
  const clean = String(hex).trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* ------------------------------------------------------------------ */
/* HMAC                                                                */
/* ------------------------------------------------------------------ */

const BLOCK_SIZE = 64;

/**
 * HMAC-SHA256。
 * @param {Uint8Array|string} key 金鑰。字串會以 UTF-8 編碼。
 * @param {Uint8Array|string} message 訊息。
 * @returns {Uint8Array} 32 bytes
 */
export function hmacSha256(key, message) {
  let k = typeof key === 'string' ? utf8Bytes(key) : key;
  const m = typeof message === 'string' ? utf8Bytes(message) : message;

  if (k.length > BLOCK_SIZE) k = sha256(k);

  const padded = new Uint8Array(BLOCK_SIZE);
  padded.set(k);

  const inner = new Uint8Array(BLOCK_SIZE + m.length);
  const outerPrefix = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    inner[i] = padded[i] ^ 0x36;
    outerPrefix[i] = padded[i] ^ 0x5c;
  }
  inner.set(m, BLOCK_SIZE);

  const innerHash = sha256(inner);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  outer.set(outerPrefix);
  outer.set(innerHash, BLOCK_SIZE);

  return sha256(outer);
}

/** HMAC-SHA256 的十六進位字串，Bybit 簽章要的格式 */
export function hmacSha256Hex(key, message) {
  return toHex(hmacSha256(key, message));
}
