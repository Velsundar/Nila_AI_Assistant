import { Router } from "express";
import { AgentRequestSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { runAgent } from "../agent/agent";
import type { LlmClient } from "../agent/llm";

export function agentRouter(getLlm?: () => LlmClient) {
  const r = Router();
  r.post(
    "/",
    ah(async (req, res) => {
      const input = parse(AgentRequestSchema, req.body);
      res.json(await runAgent(req.user!, input, getLlm ? { llm: getLlm() } : {}));
    }),
  );
  return r;
}
