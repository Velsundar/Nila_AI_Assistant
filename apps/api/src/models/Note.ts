import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const noteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);
// Word search with stemming for GET /notes?q= and the agent's note search.
noteSchema.index({ text: "text" });
noteSchema.index({ userId: 1, updatedAt: -1 });

export type NoteDoc = HydratedDocument<InferSchemaType<typeof noteSchema>>;
export const NoteModel = model("Note", noteSchema);
