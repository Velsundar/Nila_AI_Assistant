import { Schema, model } from "mongoose";

const memorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    fact: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

export const MemoryModel = model("Memory", memorySchema);
