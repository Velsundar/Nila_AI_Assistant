import { Types, isValidObjectId } from "mongoose";
import type { Note } from "@nova/shared";
import { NoteModel } from "../models/Note";
import { notFound } from "../errors";
import { toNote } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words that say "it's a note" rather than what the note is about. */
const QUERY_FILLER = new Set([
  "what", "was", "is", "my", "the", "a", "an", "note", "notes", "about", "on", "for", "find", "search", "show", "me",
  "did", "i", "save", "saved", "write", "wrote", "of", "that", "this", "where", "whats", "tell",
]);

export function queryTerms(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !QUERY_FILLER.has(w));
}

export async function createNote(userId: string, text: string): Promise<Note> {
  return toNote(await NoteModel.create({ userId: oid(userId), text: text.trim() }));
}

/**
 * Newest first. With `q`: MongoDB text search (stemmed words, ranked by relevance), falling back to
 * a case-insensitive substring match on any term so partial words like "wif" still hit.
 */
export async function listNotes(userId: string, q?: string, limit = 200): Promise<Note[]> {
  const base = { userId: oid(userId) };
  const query = q?.trim();
  if (!query) {
    return (await NoteModel.find(base).sort({ updatedAt: -1 }).limit(limit).lean()).map(toNote);
  }
  const textHits = await NoteModel.find({ ...base, $text: { $search: query } }, { score: { $meta: "textScore" } })
    .sort({ score: { $meta: "textScore" }, updatedAt: -1 })
    .limit(limit)
    .lean();
  if (textHits.length) return textHits.map(toNote);
  const terms = queryTerms(query);
  const alts = (terms.length ? terms : [query]).map((t) => ({ text: new RegExp(escapeRe(t), "i") }));
  return (await NoteModel.find({ ...base, $or: alts }).sort({ updatedAt: -1 }).limit(limit).lean()).map(toNote);
}

/** Best match for a spoken query, e.g. "my wifi password note". */
export async function searchNotes(userId: string, q: string, limit = 3): Promise<Note[]> {
  const terms = queryTerms(q);
  const hits = await listNotes(userId, terms.length ? terms.join(" ") : q, limit);
  return hits;
}

export async function updateNote(userId: string, id: string, text: string): Promise<Note> {
  if (!isValidObjectId(id)) throw notFound("Note");
  const doc = await NoteModel.findOneAndUpdate({ _id: id, userId: oid(userId) }, { $set: { text: text.trim() } }, { new: true }).lean();
  if (!doc) throw notFound("Note");
  return toNote(doc);
}

export async function deleteNote(userId: string, id: string): Promise<Note> {
  if (!isValidObjectId(id)) throw notFound("Note");
  const doc = await NoteModel.findOneAndDelete({ _id: id, userId: oid(userId) }).lean();
  if (!doc) throw notFound("Note");
  return toNote(doc);
}
