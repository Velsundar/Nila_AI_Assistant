import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export const MAX_STORED_MESSAGES = 20;

export type StoredMessage = { role: "user" | "assistant"; content: string; at: Date };
export type PendingAction = { tool: string; args: Record<string, unknown>; summary: string };

export interface ConversationShape {
  userId: Types.ObjectId;
  messages: StoredMessage[];
  pendingAction?: PendingAction | null;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<StoredMessage>(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const conversationSchema = new Schema<ConversationShape>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    messages: { type: [messageSchema], default: [] },
    pendingAction: {
      type: new Schema<PendingAction>(
        { tool: String, args: Schema.Types.Mixed, summary: String },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

conversationSchema.pre("save", function (next) {
  if (this.messages.length > MAX_STORED_MESSAGES) {
    this.messages = this.messages.slice(-MAX_STORED_MESSAGES);
  }
  next();
});

export type ConversationDoc = HydratedDocument<ConversationShape>;
export const ConversationModel = model<ConversationShape>("Conversation", conversationSchema);
