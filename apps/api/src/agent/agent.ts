import { isValidObjectId, Types } from "mongoose";
import type { AgentAction, AgentRequest, AgentResponse } from "@nova/shared";
import { ASSISTANT_NAME, DEFAULT_CURRENCY } from "@nova/shared";
import { config } from "../config";
import type { UserDoc } from "../models/User";
import { MemoryModel } from "../models/Memory";
import { ConversationModel, type ConversationDoc, type PendingAction } from "../models/Conversation";
import { resolveTimezone } from "../services/dates";
import { HttpError } from "../errors";
import { friendlyLlmError, getLlmClient, type ChatMessage, type LlmClient, type LlmContext } from "./llm";
import { buildSystemPrompt } from "./prompt";
import { formatZodIssues, stripNulls, TOOL_DEFINITIONS, TOOL_MAP, ToolError, type ToolContext } from "./tools";
import { formatMoney, sanitizeForSpeech } from "./format";

export const MAX_ITERATIONS = 5;
export const HISTORY_MESSAGES = 10;

const AFFIRMATIVE =
  /^(yes|yeah|yea|yep|yup|ya|yah|haan|haa|han|ha|haan ji|ji|ji haan|sure|ok|okay|confirm|confirmed|do it|go ahead|please do|proceed|correct|right|absolutely|definitely|of course|delete it|y)\b/;
const NEGATIVE =
  /^(no|nope|nah|nahi|nahin|na|cancel|don'?t|do not|stop|never ?mind|leave it|forget it|keep it|n)\b/;

export function classifyConfirmation(message: string): "yes" | "no" | "other" {
  const t = message.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 8) return "other";
  if (NEGATIVE.test(t)) return "no";
  if (AFFIRMATIVE.test(t)) return "yes";
  return "other";
}

async function loadConversation(userId: string, conversationId?: string): Promise<ConversationDoc> {
  if (conversationId && isValidObjectId(conversationId)) {
    const existing = await ConversationModel.findOne({ _id: conversationId, userId: new Types.ObjectId(userId) });
    if (existing) return existing;
  }
  return new ConversationModel({ userId: new Types.ObjectId(userId), messages: [] });
}

function errorMessage(e: unknown): string {
  if (e instanceof ToolError || e instanceof HttpError) return e.message;
  console.error("[agent] tool crashed:", e);
  return "Internal error while running the tool";
}

async function executePending(pending: PendingAction, ctx: ToolContext): Promise<{ action: AgentAction; reply: string }> {
  const tool = TOOL_MAP.get(pending.tool);
  if (!tool) return { action: { tool: pending.tool, args: pending.args, ok: false, error: "Unknown tool" }, reply: "Sorry, I couldn't do that." };
  try {
    const args = tool.schema.parse(pending.args);
    const result = (await tool.execute(args, ctx)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    let reply = "Done.";
    if (pending.tool === "deleteExpense") {
      const d = result.deleted;
      reply = `Done, I deleted ${formatMoney(d.amount, ctx.currency)}${d.merchant ? ` at ${d.merchant}` : d.note ? ` for ${d.note}` : ""}.`;
    } else if (pending.tool === "updateExpense") {
      const e = result.expense;
      reply = `Done. It's now ${formatMoney(e.amount, ctx.currency)} under ${e.category}${e.merchant ? ` at ${e.merchant}` : ""}.`;
    }
    return { action: { tool: pending.tool, args: pending.args, ok: true, result }, reply };
  } catch (e) {
    const msg = errorMessage(e);
    return { action: { tool: pending.tool, args: pending.args, ok: false, error: msg }, reply: `Sorry, I couldn't do that. ${msg}` };
  }
}

export type RunAgentDeps = { llm?: LlmClient };

export async function runAgent(user: UserDoc, input: AgentRequest, deps: RunAgentDeps = {}): Promise<AgentResponse> {
  const llm = deps.llm ?? getLlmClient();
  const userId = user._id.toString();
  const timezone = resolveTimezone(input.timezone, config.defaultTimezone);
  const now = new Date();
  const currency = user.currency || DEFAULT_CURRENCY;
  const ctx: ToolContext = { userId, timezone, now, currency };
  const message = input.message.trim();

  const conv = await loadConversation(userId, input.conversationId);
  const actions: AgentAction[] = [];
  let reply: string | undefined;
  let pendingConfirmation: { summary: string } | undefined;

  // 1) A destructive action is awaiting yes/no.
  const pa = conv.pendingAction;
  const pending: PendingAction | null = pa?.tool ? { tool: pa.tool, args: { ...(pa.args ?? {}) }, summary: pa.summary } : null;
  if (pending) {
    conv.pendingAction = null;
    const kind = classifyConfirmation(message);
    if (kind === "yes") {
      const r = await executePending(pending, ctx);
      actions.push(r.action);
      reply = r.reply;
    } else if (kind === "no") {
      reply = "Okay, I've cancelled that.";
    }
  }

  // 2) Normal LLM tool loop.
  if (reply === undefined) {
    const memories = (await MemoryModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(30).lean()).map((m) => m.fact).reverse();
    const llmCtx: LlmContext = {
      timezone,
      now,
      userName: user.name,
      assistantName: user.assistantName || ASSISTANT_NAME,
      currency,
      memories,
    };
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ ...llmCtx }) },
      ...conv.messages.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: "user", content: message },
    ];

    try {
      loop: for (let i = 0; i < MAX_ITERATIONS; i++) {
        const out = await llm.chat({ messages, tools: TOOL_DEFINITIONS, context: llmCtx });
        if (!out.toolCalls.length) {
          reply = out.content ?? "";
          break;
        }
        messages.push({ role: "assistant", content: out.content, tool_calls: out.toolCalls });

        for (const call of out.toolCalls) {
          const name = call.function.name;
          const respond = (payload: unknown) =>
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(payload) });
          const tool = TOOL_MAP.get(name);
          if (!tool) {
            respond({ error: `Unknown tool "${name}". Available: ${[...TOOL_MAP.keys()].join(", ")}` });
            continue;
          }
          let raw: unknown;
          try {
            raw = stripNulls(call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {});
          } catch {
            respond({ error: "Arguments were not valid JSON" });
            continue;
          }
          const parsed = tool.schema.safeParse(raw);
          if (!parsed.success) {
            respond({ error: `Invalid arguments: ${formatZodIssues(parsed.error)}` });
            continue;
          }

          if (tool.destructive && tool.prepare) {
            try {
              const prep = await tool.prepare(parsed.data, ctx);
              conv.pendingAction = { tool: name, args: prep.args, summary: prep.summary };
              pendingConfirmation = { summary: prep.summary };
              reply = `${prep.summary} Say yes or no.`;
              break loop; // stop here and wait for the user's yes/no
            } catch (e) {
              respond({ error: errorMessage(e) });
              continue;
            }
          }

          try {
            const result = await tool.execute(parsed.data, ctx);
            actions.push({ tool: name, args: parsed.data as Record<string, unknown>, ok: true, result });
            respond(result);
          } catch (e) {
            const msg = errorMessage(e);
            actions.push({ tool: name, args: parsed.data as Record<string, unknown>, ok: false, error: msg });
            respond({ error: msg });
          }
        }
      }
      if (reply === undefined || !reply.trim()) {
        reply = actions.some((a) => a.ok) ? "Done." : "Sorry, I couldn't work that out. Could you say it another way?";
      }
    } catch (e) {
      console.warn(`[agent] LLM error (${llm.provider}):`, (e as Error).message);
      reply = friendlyLlmError(e);
    }
  }

  reply = sanitizeForSpeech(reply) || "Okay.";
  conv.messages.push({ role: "user", content: message, at: now }, { role: "assistant", content: reply, at: new Date() });
  await conv.save();

  return {
    reply,
    conversationId: conv._id.toString(),
    actions,
    ...(pendingConfirmation ? { pendingConfirmation } : {}),
  };
}
