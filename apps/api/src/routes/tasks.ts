import { Router } from "express";
import { CreateTaskSchema, TaskQuerySchema, UpdateTaskSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import * as svc from "../services/tasks";

export const tasksRouter = Router();

tasksRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parse(TaskQuerySchema, req.query);
    const tasks = await svc.listTasks(uid(req), { list: q.list, done: q.done === undefined ? undefined : q.done === "true" }, reqTimezone(req));
    res.json({ tasks });
  }),
);

tasksRouter.post(
  "/",
  ah(async (req, res) => {
    const input = parse(CreateTaskSchema, req.body);
    res.status(201).json({ task: await svc.createTask(uid(req), input, reqTimezone(req)) });
  }),
);

tasksRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const input = parse(UpdateTaskSchema, req.body);
    res.json({ task: await svc.updateTask(uid(req), req.params.id, input, reqTimezone(req)) });
  }),
);

tasksRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteTask(uid(req), req.params.id);
    res.status(204).end();
  }),
);
