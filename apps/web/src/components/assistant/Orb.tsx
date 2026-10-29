"use client";

import { useEffect, useRef, type MutableRefObject } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

type RGB = [number, number, number];
const PALETTE: Record<OrbState, { a: RGB; b: RGB }> = {
  idle: { a: [94, 234, 212], b: [99, 102, 241] }, // teal → indigo
  listening: { a: [52, 211, 153], b: [34, 211, 238] }, // green → cyan
  thinking: { a: [167, 139, 250], b: [79, 70, 229] }, // violet → deep indigo
  speaking: { a: [56, 189, 248], b: [94, 234, 212] }, // sky → teal
};
const STATES: OrbState[] = ["idle", "listening", "thinking", "speaking"];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
const mixRGB = (x: RGB, y: RGB, t: number): RGB => [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)];

/** Cheap smooth pseudo-noise around the circle. */
const wave = (th: number, t: number) => Math.sin(3 * th + t * 2.1) * 0.5 + Math.sin(5 * th - t * 1.7) * 0.3 + Math.sin(9 * th + t * 3.3) * 0.2;

/**
 * The assistant's "robot orb": a canvas-rendered glowing core with a face, whose look blends
 * smoothly between four states. `levelRef` is live mic loudness (0..1) for the listening state.
 */
export function Orb({ state, levelRef, label }: { state: OrbState; levelRef: MutableRefObject<number>; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const speed = reduced ? 0.35 : 1;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Smoothed per-state weights (sum ≈ 1) so transitions cross-fade.
    const weight: Record<OrbState, number> = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
    let color = { a: [...PALETTE.idle.a] as RGB, b: [...PALETTE.idle.b] as RGB };
    let level = 0;
    let t = 0;
    let last = performance.now();
    let nextBlink = 2.5;
    let blink = 0;
    const ripples: { r: number; a: number }[] = [];
    let rippleClock = 0;
    const particles = Array.from({ length: 18 }, (_, i) => ({ ang: (i / 18) * Math.PI * 2, rad: 1.3 + (i % 3) * 0.18, spd: 0.6 + (i % 5) * 0.22, size: 1 + (i % 4) * 0.6 }));
    let raf = 0;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000) * speed;
      last = now;
      t += dt;
      const s = stateRef.current;
      for (const k of STATES) weight[k] = lerp(weight[k], k === s ? 1 : 0, 1 - Math.exp(-dt * 6));
      const target = PALETTE[s];
      const ct = 1 - Math.exp(-dt * 4);
      color = { a: mixRGB(color.a, target.a, ct), b: mixRGB(color.b, target.b, ct) };
      level = lerp(level, levelRef.current, 0.35);

      // Synthetic speech envelope for the speaking state (TTS audio isn't tappable).
      const talk = weight.speaking * (0.45 + 0.35 * Math.sin(t * 9.3) * Math.sin(t * 3.1 + 1) + 0.2 * Math.sin(t * 17));
      const listen = weight.listening * level;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.22;
      const breath = Math.sin(t * 1.1) * 0.035 * (weight.idle + weight.thinking * 0.4);
      const coreR = R * (1 + breath + listen * 0.18 + talk * 0.06);

      // 1) Halo
      // Clamp so the gradient fully fades before the canvas edge (no visible square).
      const haloR = Math.min(R * (2.5 + listen * 0.8 + talk * 0.4), Math.min(w, h) / 2);
      const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, haloR);
      halo.addColorStop(0, rgba(color.a, 0.35 + listen * 0.3 + talk * 0.15));
      halo.addColorStop(0.45, rgba(color.b, 0.12 + listen * 0.1));
      halo.addColorStop(1, rgba(color.b, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      ctx.lineCap = "round";

      // 2) Idle: slow dashed orbit ring
      if (weight.idle > 0.01) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.15);
        ctx.setLineDash([2, 10]);
        ctx.strokeStyle = rgba(color.a, 0.35 * weight.idle);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, R * 1.55, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);
      }

      // 3) Listening: radial equaliser bars driven by mic volume
      if (weight.listening > 0.01) {
        const bars = 72;
        for (let i = 0; i < bars; i++) {
          const th = (i / bars) * Math.PI * 2;
          const n = 0.5 + 0.5 * wave(th, t * 2.2);
          const len = R * (0.06 + (0.08 + level * 0.75) * n);
          const r0 = coreR * 1.18;
          ctx.strokeStyle = rgba(mixRGB(color.a, color.b, n), (0.25 + 0.65 * n) * weight.listening);
          ctx.lineWidth = Math.max(1.5, R * 0.025);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(th) * r0, cy + Math.sin(th) * r0);
          ctx.lineTo(cx + Math.cos(th) * (r0 + len), cy + Math.sin(th) * (r0 + len));
          ctx.stroke();
        }
      }

      // 4) Thinking: counter-rotating arc rings + orbiting particles
      if (weight.thinking > 0.01) {
        const wt = weight.thinking;
        const rings = [
          { r: 1.32, spd: 1.6, len: 1.4, lw: 3 },
          { r: 1.52, spd: -1.1, len: 2.2, lw: 2 },
          { r: 1.74, spd: 0.7, len: 0.9, lw: 1.5 },
        ];
        for (const ring of rings) {
          const start = t * ring.spd;
          for (let k = 0; k < 2; k++) {
            const a0 = start + k * Math.PI;
            const grad = ctx.createLinearGradient(cx + Math.cos(a0) * R * ring.r, cy + Math.sin(a0) * R * ring.r, cx + Math.cos(a0 + ring.len) * R * ring.r, cy + Math.sin(a0 + ring.len) * R * ring.r);
            grad.addColorStop(0, rgba(color.a, 0));
            grad.addColorStop(1, rgba(color.a, 0.9 * wt));
            ctx.strokeStyle = grad;
            ctx.lineWidth = ring.lw;
            ctx.beginPath();
            ctx.arc(cx, cy, R * ring.r, a0, a0 + ring.len);
            ctx.stroke();
          }
        }
        for (const p of particles) {
          const a = p.ang + t * p.spd;
          const rr = R * (p.rad + 0.06 * Math.sin(t * 2 + p.ang * 3));
          ctx.fillStyle = rgba(mixRGB(color.a, [255, 255, 255], 0.4), 0.8 * wt);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 5) Speaking: expanding ripples + a waveform ring
      rippleClock += dt;
      if (weight.speaking > 0.3 && rippleClock > 0.55) {
        rippleClock = 0;
        ripples.push({ r: 1.05, a: 0.6 });
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += dt * 0.9;
        rp.a -= dt * 0.5;
        if (rp.a <= 0) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = rgba(color.a, rp.a);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R * rp.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (weight.speaking > 0.01) {
        ctx.strokeStyle = rgba(color.a, 0.75 * weight.speaking);
        ctx.lineWidth = 2;
        ctx.beginPath();
        const seg = 160;
        for (let i = 0; i <= seg; i++) {
          const th = (i / seg) * Math.PI * 2;
          const rr = R * 1.28 + R * 0.09 * talk * Math.sin(th * 8 + t * 10) * Math.sin(th * 3 - t * 4);
          const x = cx + Math.cos(th) * rr;
          const y = cy + Math.sin(th) * rr;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 6) Core blob (deforms with voice)
      const deform = 0.015 + listen * 0.16 + talk * 0.06 + weight.thinking * 0.02;
      ctx.save();
      ctx.shadowColor = rgba(color.a, 0.9);
      ctx.shadowBlur = R * (0.5 + listen * 0.6 + talk * 0.3);
      ctx.beginPath();
      const pts = 96;
      for (let i = 0; i <= pts; i++) {
        const th = (i / pts) * Math.PI * 2;
        const rr = coreR * (1 + deform * wave(th, t * (1.5 + listen * 3)));
        const x = cx + Math.cos(th) * rr;
        const y = cy + Math.sin(th) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const core = ctx.createRadialGradient(cx - coreR * 0.35, cy - coreR * 0.4, coreR * 0.05, cx, cy, coreR * 1.05);
      core.addColorStop(0, "rgba(240,255,252,0.98)");
      core.addColorStop(0.35, rgba(color.a, 0.95));
      core.addColorStop(1, rgba(color.b, 0.95));
      ctx.fillStyle = core;
      ctx.fill();
      ctx.restore();

      // Inner sheen
      const sheen = ctx.createRadialGradient(cx, cy + coreR * 0.5, 0, cx, cy + coreR * 0.5, coreR);
      sheen.addColorStop(0, rgba(color.b, 0.35));
      sheen.addColorStop(1, rgba(color.b, 0));
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // 7) Face: two capsule eyes that blink, widen while listening, glance around while thinking
      nextBlink -= dt;
      if (nextBlink <= 0) {
        blink = 1;
        nextBlink = 2.5 + Math.random() * 3.5;
      }
      blink = Math.max(0, blink - dt * 7);
      const blinkScale = 1 - Math.sin(blink * Math.PI) * 0.92;
      const eyeW = coreR * 0.17;
      const eyeH = coreR * (0.3 + weight.listening * 0.08 + listen * 0.1 - weight.speaking * 0.06 - weight.thinking * 0.06) * blinkScale;
      const gap = coreR * 0.27;
      const look = weight.thinking * Math.sin(t * 1.4) * coreR * 0.14;
      const lookY = -weight.thinking * coreR * 0.08 + talk * coreR * 0.015;
      ctx.fillStyle = "rgba(5,8,18,0.92)";
      for (const side of [-1, 1]) {
        const ex = cx + side * gap + look - eyeW / 2;
        const ey = cy - coreR * 0.05 + lookY - eyeH / 2;
        const r = Math.min(eyeW, eyeH) / 2;
        ctx.beginPath();
        ctx.roundRect(ex, ey, eyeW, Math.max(eyeH, 1.5), r);
        ctx.fill();
      }
      // Speaking: a small mouth bar that opens with the envelope
      if (weight.speaking > 0.05) {
        const mw = coreR * 0.26;
        const mh = Math.max(1.5, coreR * 0.12 * talk);
        ctx.fillStyle = `rgba(5,8,18,${0.85 * weight.speaking})`;
        ctx.beginPath();
        ctx.roundRect(cx - mw / 2 + look, cy + coreR * 0.32 - mh / 2, mw, mh, mh / 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [levelRef]);

  return <canvas ref={canvasRef} role="img" aria-label={label} className="block size-full" />;
}
