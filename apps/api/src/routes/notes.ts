import { Router } from "express";
import { z } from "zod";
import { CreateNoteSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { uid } from "../middleware/auth";
import * as svc from "../services/notes";

export const notesRouter = Router();

notesRouter.get(
  "/",
  ah(async (req, res) => {
    const { q } = parse(z.object({ q: z.string().max(200).optional() }), req.query);
    res.json({ notes: await svc.listNotes(uid(req), q) });
  }),
);

notesRouter.post(
  "/",
  ah(async (req, res) => {
    const { text } = parse(CreateNoteSchema, req.body);
    res.status(201).json({ note: await svc.createNote(uid(req), text) });
  }),
);

notesRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const { text } = parse(CreateNoteSchema, req.body);
    res.json({ note: await svc.updateNote(uid(req), req.params.id, text) });
  }),
);

notesRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteNote(uid(req), req.params.id);
    res.status(204).end();
  }),
);
