"use client";

/**
 * Decode a WAV clip, cut its leading silence (Orpheus clips start with ~0.3–0.45 s of it) and
 * normalise its peak (the quieter acks, "Mm-hmm." / "Sure."), then re-encode as 16-bit PCM WAV.
 * Used for the interrupt acks so they sound instantly. Returns the input on any failure.
 */
export async function trimAndNormalize(blob: Blob, { threshold = 0.02, padMs = 25, peak = 0.9, maxGain = 4 } = {}): Promise<Blob> {
  try {
    const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Offline) return blob;
    const decoded = await new Offline(1, 1, 24000).decodeAudioData(await blob.arrayBuffer());
    const ch = decoded.getChannelData(0);
    let start = 0;
    while (start < ch.length && Math.abs(ch[start]) < threshold) start++;
    let end = ch.length - 1;
    while (end > start && Math.abs(ch[end]) < threshold / 2) end--;
    if (start >= end) return blob;
    start = Math.max(0, start - Math.round((padMs / 1000) * decoded.sampleRate));
    end = Math.min(ch.length - 1, end + Math.round(0.06 * decoded.sampleRate));
    let max = 0;
    for (let i = start; i <= end; i++) max = Math.max(max, Math.abs(ch[i]));
    const gain = max > 0 ? Math.min(maxGain, peak / max) : 1;
    return encodeWav(ch.subarray(start, end + 1), decoded.sampleRate, gain);
  } catch {
    return blob;
  }
}

function encodeWav(samples: Float32Array, rate: number, gain: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
