"use client";

import type { Note } from "@nova/shared";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, Card, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DATA_CHANGED_EVENT, DATA_VERSION_KEY, notifyDataChanged } from "@/lib/events";
import { shortDate } from "@/lib/format";

const areaCls =
  "w-full resize-y rounded-control border border-line bg-surface-2 px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-faint transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 focus-visible:outline-none";

/** ⌘/Ctrl+Enter submits the surrounding form. */
const submitOnModEnter = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
};

export function NotesCard({ className }: { className?: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const reqId = useRef(0);
  const qRef = useRef(q);
  qRef.current = q;
  const base = useId();

  const load = useCallback(async (query: string) => {
    const id = ++reqId.current;
    setSearching(true);
    try {
      const { notes } = await api.notes.list({ q: query.trim() || undefined });
      if (id === reqId.current) {
        setNotes(notes);
        setError(null);
      }
    } catch (err) {
      if (id === reqId.current) setError(errorMessage(err));
    } finally {
      if (id === reqId.current) setSearching(false);
    }
  }, []);

  // Debounced server-side search.
  useEffect(() => {
    const t = setTimeout(() => void load(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  useEffect(() => {
    const on = () => void load(qRef.current);
    const onStorage = (e: StorageEvent) => e.key === DATA_VERSION_KEY && on();
    window.addEventListener(DATA_CHANGED_EVENT, on);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DATA_CHANGED_EVENT, on);
      window.removeEventListener("storage", onStorage);
    };
  }, [load]);

  return (
    <Card title="Notes" className={className} action={notes ? <span className="text-xs tabular-nums text-faint">{notes.length}{q ? " found" : ""}</span> : undefined}>
      <QuickNote
        onAdded={(n) => {
          if (!qRef.current) setNotes((ns) => (ns ? [n, ...ns] : [n]));
        }}
      />

      <div className="relative mt-4">
        <label htmlFor={`${base}-q`} className="sr-only">
          Search notes
        </label>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          id={`${base}-q`}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search notes"
          className="h-10 w-full rounded-control border border-line bg-surface-2/60 pl-9 pr-9 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 focus-visible:outline-none"
        />
        {searching && notes && <Spinner className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" />}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      {!notes ? (
        <div className="grid h-24 place-items-center text-muted" role="status" aria-label="Loading notes">
          <Spinner className="size-5" />
        </div>
      ) : notes.length === 0 ? (
        <p className="py-6 text-center text-sm text-faint">{q ? `No notes match “${q}”.` : "No notes yet. Jot one down, or say “note that the gate code is 4521”."}</p>
      ) : (
        <ul className="mt-3 space-y-2 lg:max-h-[34rem] lg:overflow-y-auto lg:pr-0.5" aria-live="polite" aria-busy={searching || undefined}>
          {notes.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              onSaved={(u) => setNotes((ns) => ns?.map((x) => (x.id === u.id ? u : x)) ?? ns)}
              onDeleted={() => setNotes((ns) => ns?.filter((x) => x.id !== n.id) ?? ns)}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function QuickNote({ onAdded }: { onAdded: (n: Note) => void }) {
  const [text, setText] = useState("");
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return; // ref, not state: blocks same-tick double submits
    const t = text.trim();
    if (!t) return setError("Write something first.");
    setError(null);
    submitting.current = true;
    setBusy(true);
    try {
      const { note } = await api.notes.create({ text: t });
      onAdded(note);
      setText("");
      notifyDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Add a note">
      <label htmlFor={id} className="sr-only">
        New note
      </label>
      <textarea
        id={id}
        rows={2}
        value={text}
        maxLength={5000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={submitOnModEnter}
        placeholder="Quick note… (⌘/Ctrl + Enter to save)"
        aria-invalid={error ? true : undefined}
        className={cn(areaCls, error && "border-danger")}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p role={error ? "alert" : undefined} className="text-xs text-danger">
          {error}
        </p>
        <Button type="submit" size="sm" loading={busy} disabled={!text.trim()}>
          Save note
        </Button>
      </div>
    </form>
  );
}

function NoteItem({ note, onSaved, onDeleted, onError }: { note: Note; onSaved: (n: Note) => void; onDeleted: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (editing) {
      const el = areaRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    if (t === note.text) return setEditing(false);
    setBusy(true);
    try {
      const { note: updated } = await api.notes.update(note.id, { text: t });
      onSaved(updated);
      setEditing(false);
      notifyDataChanged();
      requestAnimationFrame(() => editBtn.current?.focus());
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.notes.remove(note.id);
      onDeleted();
      notifyDataChanged();
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
    }
  }

  const edited = note.updatedAt && note.updatedAt !== note.createdAt;

  return (
    <li className="rounded-control border border-line/70 bg-surface-2/40 p-3">
      {editing ? (
        <form onSubmit={save} aria-label="Edit note">
          <label htmlFor={id} className="sr-only">
            Edit note
          </label>
          <textarea
            ref={areaRef}
            id={id}
            rows={3}
            value={draft}
            maxLength={5000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(note.text);
                setEditing(false);
              } else submitOnModEnter(e);
            }}
            className={areaCls}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(note.text);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={busy} disabled={!draft.trim()}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{note.text}</p>
          <div className="mt-2 flex items-center gap-1">
            <span className="mr-auto text-[11px] text-faint">
              {shortDate(note.createdAt)}
              {edited && ` · edited ${shortDate(note.updatedAt)}`}
            </span>
            {confirming ? (
              <>
                <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <>
                <Button ref={editBtn} size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit note: ${note.text.slice(0, 40)}`}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setConfirming(true)} aria-label={`Delete note: ${note.text.slice(0, 40)}`}>
                  Delete
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}
