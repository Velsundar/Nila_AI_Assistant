import { Router } from "express";
import { z } from "zod";
import { CreateReminderSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { uid } from "../middleware/auth";
import * as svc from "../services/reminders";

export const remindersRouter = Router();

remindersRouter.get(
  "/",
  ah(async (req, res) => {
    res.json({ reminders: await svc.listReminders(uid(req)) });
  }),
);

remindersRouter.post(
  "/",
  ah(async (req, res) => {
    const input = parse(CreateReminderSchema, req.body);
    res.status(201).json({ reminder: await svc.createReminder(uid(req), input.text, input.dateTime) });
  }),
);

remindersRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const { done } = parse(z.object({ done: z.boolean() }), req.body);
    res.json({ reminder: await svc.setReminderDone(uid(req), req.params.id, done) });
  }),
);

remindersRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteReminder(uid(req), req.params.id);
    res.status(204).end();
  }),
);
