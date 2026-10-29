import { isValidObjectId, Types } from "mongoose";
import type { AgentAction, AgentRequest, AgentResponse } from "@nova/shared";
import { ASSISTANT_NAME, DEFAULT_CURRENCY } from "@nova/shared";
import { config } from "../config";
import type { UserDoc } from "../models/User";
import { MemoryModel } from "../models/Memory";
import { ConversationModel, MAX_STORED_MESSAGES, type ConversationDoc, type PendingAction } from "../models/Conversation";
import { BudgetExceededError, consumeDailyLlmCall, DAILY_LIMIT_REPLY } from "../services/usage";
import { resolveTimezone } from "../services/dates";
import { HttpError } from "../errors";
import { friendlyLlmError, getLlmClient, LlmError, type ChatMessage, type LlmClient, type LlmContext } from "./llm";
import { composeReply } from "./mock";
import { buildSystemPrompt } from "./prompt";
import { formatZodIssues, stripNulls, TOOL_DEFINITIONS, TOOL_MAP, ToolError, type ToolContext } from "./tools";
import { sanitizeForSpeech } from "./format";

export const MAX_ITERATIONS = 5;
/** Past messages sent to the model (3 exchanges). Keeps each call well under the free-tier 8k tokens/min. */
export const HISTORY_MESSAGES = 6;
/** Tool results longer than this are cut before going back to the model. */
export const MAX_TOOL_RESULT_CHARS = 1500;
/** Memories included in the system prompt (most recent). */
export const PROMPT_MEMORIES = 10;

export function toolResultContent(payload: unknown): string {
  const s = JSON.stringify(payload) ?? "null";
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : s;
}

/** A pending destructive action must be confirmed within this window. */
export const PENDING_TTL_MS = 2 * 60_000;

const YES_PHRASES = new Set([
  "yes", "yeah", "yea", "yep", "yup", "ya", "yah", "y", "haan", "haa", "han", "ha", "ji", "haan ji", "ji haan",
  "sure", "ok", "okay", "okey", "k", "alright", "all right", "confirm", "confirmed", "do it", "go ahead", "please do",
  "proceed", "correct", "right", "absolutely", "definitely", "of course", "delete it", "sounds good", "fine",
]);
const NO_PHRASES = new Set([
  "no", "nope", "nah", "nahi", "nahin", "na", "n", "cancel", "cancel it", "don't", "dont", "do not", "don't do it",
  "dont do it", "do not do it", "stop", "never mind", "nevermind", "leave it", "forget it", "keep it", "not now", "abort", "no way",
]);
/** Politeness and addressing words that don't change the meaning of a yes/no. */
const FILLER = new Set(["please", "pls", "plz", "nova", "thanks", "thank", "you", "thankyou", "sir", "madam", "bro", "hey", "oh"]);

/**
 * Strict yes/no: the WHOLE utterance (minus punctuation, politeness and the assistant's name) must
 * consist only of yes phrases or only of no phrases. "Okay, add 200 for lunch", "ok what did I
 * spend", "okay wait, don't", "sure, actually cancel" and "yes no" are all "other".
 */
export function classifyConfirmation(message: string, assistantName = ASSISTANT_NAME): "yes" | "no" | "other" {
  const name = assistantName.toLowerCase();
  const words = message
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z' ]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w && !FILLER.has(w) && w !== name && !name.split(/\s+/).includes(w));
  if (!words.length || words.length > 6) return "other";
  let yes = false;
  let no = false;
  for (let i = 0; i < words.length; ) {
    let matched = 0;
    for (let len = Math.min(4, words.length - i); len >= 1 && !matched; len--) {
      const phrase = words.slice(i, i + len).join(" ");
      if (YES_PHRASES.has(phrase)) (yes = true), (matched = len);
      else if (NO_PHRASES.has(phrase)) (no = true), (matched = len);
    }
    if (!matched) return "other"; // anything that isn't a yes/no word
    i += matched;
  }
  if (yes && no) return "other";
  return yes ? "yes" : "no";
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
    const reply = tool.confirmedReply?.(result, ctx) ?? "Done.";
    return { action: { tool: pending.tool, args: pending.args, ok: true, result }, reply };
  } catch (e) {
    const msg = errorMessage(e);
    return { action: { tool: pending.tool, args: pending.args, ok: false, error: msg }, reply: `Sorry, I couldn't do that. ${msg}` };
  }
}

export type RunAgentDeps = {
  llm?: LlmClient;
  /** Overall budget for this request (default config.llm.agentDeadlineMs). */
  deadlineMs?: number;
  /** Injected clock for pending-action expiry tests. */
  now?: Date;
};

const CONFIRM_SUFFIX = /\s*Say yes or no\.?$/;

/**
 * Past confirmation prompts are always resolved by the time the model runs (confirmed, cancelled
 * or talked past). Present them as such, or models re-issue the destructive call or echo the question.
 */
export function historyContent(m: { role: string; content: string }): string {
  if (m.role !== "assistant" || !CONFIRM_SUFFIX.test(m.content)) return m.content;
  return `(Earlier confirmation request, already resolved, do not repeat: ${m.content.replace(CONFIRM_SUFFIX, "")})`;
}

/** Remove sentences in which the model itself asks for a yes/no (it can't arm a confirmation). */
export function stripModelConfirmPrompt(reply: string): string {
  const sentences = reply.match(/[^.!?]+[.!?]*/g) ?? [reply];
  const drop = new Set<number>();
  sentences.forEach((s, i) => {
    if (!/\b(yes or no|yes\/no)\b/i.test(s)) return;
    drop.add(i);
    // "Delete X? Say yes or no." -> the question belongs to the prompt too.
    if (i > 0 && sentences[i - 1].trim().endsWith("?")) drop.add(i - 1);
  });
  return sentences
    .filter((_, i) => !drop.has(i))
    .join("")
    .trim();
}

const isExpired = (p: { createdAt?: Date | null }, now: Date) =>
  !p.createdAt || now.getTime() - new Date(p.createdAt).getTime() > PENDING_TTL_MS;

export async function runAgent(user: UserDoc, input: AgentRequest, deps: RunAgentDeps = {}): Promise<AgentResponse> {
  const llm = deps.llm ?? getLlmClient();
  const userId = user._id.toString();
  const timezone = resolveTimezone(input.timezone, config.defaultTimezone);
  const now = deps.now ?? new Date();
  const deadline = Date.now() + (deps.deadlineMs ?? config.llm.agentDeadlineMs);
  const currency = user.currency || DEFAULT_CURRENCY;
  const assistantName = user.assistantName || ASSISTANT_NAME;
  const ctx: ToolContext = { userId, timezone, now, currency, user };
  const message = input.message.trim();

  const conv = await loadConversation(userId, input.conversationId);
  const isNew = conv.isNew;
  const actions: AgentAction[] = [];
  let reply: string | undefined;
  let pendingConfirmation: { summary: string } | undefined;
  /** What pendingAction becomes after this turn (any reply other than a valid yes clears it). */
  let nextPending: PendingAction | null = null;
  /** Summary of a pending action the user talked past; the model is told not to redo it. */
  let droppedPending: string | undefined;

  // 1) A destructive action is awaiting yes/no.
  if (conv.pendingAction?.tool) {
    const kind = classifyConfirmation(message, assistantName);
    if (kind === "yes") {
      // Claim it atomically so two quick "yes" requests can't both run it.
      const claimed = await ConversationModel.findOneAndUpdate(
        { _id: conv._id, userId: user._id, pendingAction: { $ne: null } },
        { $set: { pendingAction: null } },
        { new: false },
      ).lean();
      const pa = claimed?.pendingAction;
      if (!pa?.tool) {
        reply = "That's already been taken care of.";
      } else if (isExpired(pa, now)) {
        reply = "That confirmation timed out, so I didn't do it. Ask me again if you still want it.";
      } else {
        const r = await executePending({ tool: pa.tool, args: { ...(pa.args ?? {}) }, summary: pa.summary }, ctx);
        actions.push(r.action);
        reply = r.reply;
      }
    } else if (kind === "no") {
      reply = "Okay, I've cancelled that.";
    }
    // "other": the pending action is dropped and the message is handled as a new request.
    else droppedPending = conv.pendingAction.summary;
  }

  // 2) Normal LLM tool loop.
  if (reply === undefined) {
    const memories = (await MemoryModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(PROMPT_MEMORIES).lean())
      .map((m) => m.fact)
      .reverse();
    const llmCtx: LlmContext = {
      timezone,
      ...(user.city ? { city: user.city } : {}),
      now,
      userName: user.name,
      assistantName,
      currency,
      memories,
    };
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ ...llmCtx }) },
      ...conv.messages.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: historyContent(m) }) as ChatMessage),
      // Without this, models tend to re-issue the unanswered "Delete …? Say yes or no." from history.
      ...(droppedPending
        ? [{ role: "system" as const, content: `The user did not confirm "${droppedPending}", so it was cancelled. Do not do it again unless this new message asks for it.` }]
        : []),
      { role: "user", content: message },
    ];

    try {
      loop: for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (Date.now() >= deadline) throw new LlmError("timeout", "Agent deadline exceeded");
        if (llm.provider !== "mock") await consumeDailyLlmCall(userId);
        const out = await llm.chat({ messages, tools: TOOL_DEFINITIONS, context: llmCtx, deadline });
        if (!out.toolCalls.length) {
          reply = out.content ?? "";
          break;
        }
        messages.push({ role: "assistant", content: out.content, tool_calls: out.toolCalls });

        // Non-destructive calls run in order; a call that needs confirmation is prepared (read-only)
        // and parked, and the turn ends after the whole batch so no other call is silently dropped.
        let parked: { pending: PendingAction } | undefined;
        for (const call of out.toolCalls) {
          const name = call.function.name;
          const respond = (payload: unknown) =>
            messages.push({ role: "tool", tool_call_id: call.id, name, content: toolResultContent(payload) });
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

          let needsConfirm = false;
          try {
            needsConfirm = !!tool.prepare && (!!tool.destructive || !!(await tool.confirmIf?.(parsed.data, ctx)));
          } catch (e) {
            respond({ error: errorMessage(e) });
            continue;
          }
          if (needsConfirm) {
            if (parked) {
              respond({ error: "Only one change that needs confirmation at a time. Ask again after the user answers." });
              continue;
            }
            try {
              const prep = await tool.prepare!(parsed.data, ctx);
              parked = { pending: { tool: name, args: prep.args, summary: prep.summary, createdAt: new Date() } };
              respond({ awaitingConfirmation: prep.summary });
            } catch (e) {
              respond({ error: errorMessage(e) });
            }
            continue;
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

        if (parked) {
          nextPending = parked.pending;
          pendingConfirmation = { summary: parked.pending.summary };
          // Speak what already happened this turn (deterministic templates, no extra LLM call).
          const done = actions
            .filter((a) => a.ok)
            .map((a) => composeReply(a.tool, a.result as Record<string, unknown>, llmCtx, message))
            .filter((t) => t && t !== "Done.");
          reply = [...done, `${parked.pending.summary} Say yes or no.`].join(" ");
          break loop;
        }
      }
      // Only the server can arm a yes/no. Drop any "say yes or no" the model wrote on its own.
      if (reply !== undefined && !pendingConfirmation) reply = stripModelConfirmPrompt(reply);
      if (reply === undefined || !reply.trim()) {
        reply = actions.some((a) => a.ok) ? "Done." : "Sorry, I couldn't work that out. Could you say it another way?";
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        reply = DAILY_LIMIT_REPLY;
      } else {
        console.warn(`[agent] LLM error (${llm.provider}):`, (e as Error).message);
        reply = friendlyLlmError(e);
      }
    }
  }

  reply = sanitizeForSpeech(reply) || "Okay.";
  const turn = [
    { role: "user" as const, content: message, at: now },
    { role: "assistant" as const, content: reply, at: new Date() },
  ];
  if (isNew) {
    conv.messages.push(...turn);
    conv.pendingAction = nextPending;
    await conv.save();
  } else {
    // Atomic append (no read-modify-write of the whole document) so concurrent turns can't clobber each other.
    await ConversationModel.updateOne(
      { _id: conv._id, userId: user._id },
      { $push: { messages: { $each: turn, $slice: -MAX_STORED_MESSAGES } }, $set: { pendingAction: nextPending } },
    );
  }

  return {
    reply,
    conversationId: conv._id.toString(),
    actions,
    ...(pendingConfirmation ? { pendingConfirmation } : {}),
  };
}
