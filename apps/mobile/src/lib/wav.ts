/**
 * Trims leading near-silence from a PCM WAV (pure; unit-checked on a real /api/speak clip).
 * Orpheus clips start with ~0.3–0.45 s of silence, which makes the interrupt acks feel slow.
 * Only 16-bit PCM is trimmed; anything else (or a malformed header) is returned unchanged.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]!;
    const b = LOOKUP[clean.charCodeAt(i + 1)]!;
    const c = LOOKUP[clean.charCodeAt(i + 2)]!;
    const d = LOOKUP[clean.charCodeAt(i + 3)]!;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < len && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

export type WavInfo = { channels: number; sampleRate: number; bitsPerSample: number; dataOffset: number; dataBytes: number };

export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes"> | null = null;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      if (view.getUint16(off + 8, true) !== 1) return null; // PCM only
      fmt = { channels: view.getUint16(off + 10, true), sampleRate: view.getUint32(off + 12, true), bitsPerSample: view.getUint16(off + 22, true) };
    } else if (id === "data") {
      if (!fmt) return null;
      const dataOffset = off + 8;
      // Streaming encoders may write 0 / 0xFFFFFFFF: use what's actually there.
      const dataBytes = size === 0 || dataOffset + size > bytes.length ? bytes.length - dataOffset : size;
      return { ...fmt, dataOffset, dataBytes };
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

/**
 * Drops leading samples quieter than `threshold` (of full scale), keeping `padMs` before the first
 * sound. Returns the original bytes if there's nothing to trim or the format isn't 16-bit PCM.
 */
export function trimLeadingSilence(bytes: Uint8Array, threshold = 0.02, padMs = 40): { bytes: Uint8Array; trimmedMs: number } {
  const info = parseWav(bytes);
  if (!info || info.bitsPerSample !== 16 || info.channels < 1) return { bytes, trimmedMs: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameBytes = 2 * info.channels;
  const limit = Math.round(threshold * 32767);
  const frames = Math.floor(info.dataBytes / frameBytes);
  let first = frames;
  for (let f = 0; f < frames; f++) {
    const p = info.dataOffset + f * frameBytes;
    let loud = false;
    for (let c = 0; c < info.channels; c++) if (Math.abs(view.getInt16(p + c * 2, true)) > limit) loud = true;
    if (loud) {
      first = f;
      break;
    }
  }
  if (first >= frames) return { bytes, trimmedMs: 0 }; // all silent: leave alone
  const cutFrames = Math.max(0, first - Math.round((padMs / 1000) * info.sampleRate));
  if (cutFrames === 0) return { bytes, trimmedMs: 0 };
  const cut = cutFrames * frameBytes;
  const newData = info.dataBytes - cut;
  const out = new Uint8Array(info.dataOffset + newData);
  out.set(bytes.subarray(0, info.dataOffset), 0);
  out.set(bytes.subarray(info.dataOffset + cut, info.dataOffset + info.dataBytes), info.dataOffset);
  const ov = new DataView(out.buffer);
  ov.setUint32(4, out.length - 8, true); // RIFF size
  ov.setUint32(info.dataOffset - 4, newData, true); // data size
  return { bytes: out, trimmedMs: Math.round((cutFrames / info.sampleRate) * 1000) };
}
