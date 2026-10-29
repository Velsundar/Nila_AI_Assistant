"use client";

import type { ReceiptScanResult } from "@nova/shared";
import { useCallback, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { imageToJpegDataUrl } from "@/lib/image";

export type ScanOutcome = ReceiptScanResult & { preview: string };

/** Downscale + upload one image to /receipts/scan. */
export function useReceiptScan(onResult: (r: ScanOutcome) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cb = useRef(onResult);
  cb.current = onResult;

  const busyRef = useRef(false);
  const scan = useCallback(async (file: File | Blob | null | undefined) => {
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      const image = await imageToJpegDataUrl(file);
      const res = await api.receipts.scan({ image });
      cb.current({ ...res, preview: image });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { scan, busy, error, clearError: () => setError(null) };
}

const CameraIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8a2 2 0 0 1 2-2h1.5l1.4-2h6.2l1.4 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" />
    <circle cx="12" cy="12.5" r="3.5" />
  </svg>
);

/** Drop zone + "Take photo" / "Upload" buttons. Used in the dashboard's Add-expense card. */
export function ReceiptDropzone({ onResult, className }: { onResult: (r: ScanOutcome) => void; className?: string }) {
  const { scan, busy, error } = useReceiptScan(onResult);
  const [over, setOver] = useState(false);
  const fileId = useId();
  const camId = useId();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void scan(e.dataTransfer.files?.[0]);
  };

  return (
    <div className={className}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        aria-busy={busy || undefined}
        className={cn(
          "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 rounded-control border border-dashed px-3 py-3 transition-colors",
          over ? "border-accent bg-accent/10" : "border-line-strong bg-surface-2/40",
        )}
      >
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-accent">
          {busy ? <Spinner className="size-4" /> : <CameraIcon className="size-4.5" />}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-fg">{busy ? "Reading receipt…" : "Scan a receipt"}</p>
          <p className="text-xs text-faint">Drop a photo here, or pick one. You&apos;ll check it before saving.</p>
        </div>
        <div className="col-span-2 flex gap-2 [&>*]:flex-1 [&>*>span:last-child]:w-full">
          <FileButton id={camId} capture onFile={scan} disabled={busy} className="sm:hidden" label="Take a photo of a receipt">
            Camera
          </FileButton>
          <FileButton id={fileId} onFile={scan} disabled={busy} label="Upload a receipt image">
            Upload photo
          </FileButton>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** A label-styled-as-button wrapping a hidden file input (works with keyboard via the input). */
export function FileButton({
  id,
  onFile,
  capture,
  disabled,
  className,
  children,
  iconOnly,
  label,
}: {
  id: string;
  onFile: (f: File | undefined) => void;
  capture?: boolean;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  iconOnly?: boolean;
  /** Accessible name for the file input. */
  label: string;
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <input
        id={id}
        type="file"
        accept="image/*"
        {...(capture ? { capture: "environment" as const } : {})}
        disabled={disabled}
        aria-label={label}
        className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-flex items-center justify-center gap-1.5 rounded-control border border-line bg-surface-2 text-sm font-medium text-fg transition-colors",
          "peer-hover:border-line-strong peer-hover:bg-surface-3 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-50",
          iconOnly ? "size-10 rounded-full" : "h-8 px-3",
        )}
      >
        {iconOnly ? <CameraIcon className="size-4.5" /> : children}
      </span>
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: ReceiptScanResult["confidence"] }) {
  const tone = {
    high: "border-ok/40 bg-ok/10 text-ok",
    medium: "border-warn/40 bg-warn/10 text-warn",
    low: "border-danger/40 bg-danger/10 text-danger",
  }[confidence];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", tone)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {confidence[0].toUpperCase() + confidence.slice(1)} confidence
    </span>
  );
}
