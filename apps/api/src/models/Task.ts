import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const taskSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    /** Display name of the list, e.g. "Shopping". */
    list: { type: String, required: true, trim: true },
    /** Lower-cased list name for case-insensitive filtering. */
    listKey: { type: String, required: true },
    dueDate: { type: Date },
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    done: { type: Boolean, default: false },
    completedAt: { type: Date },
  },
  { timestamps: true },
);
taskSchema.index({ userId: 1, done: 1, dueDate: 1 });
taskSchema.index({ userId: 1, listKey: 1 });

export type TaskDoc = HydratedDocument<InferSchemaType<typeof taskSchema>>;
export const TaskModel = model("Task", taskSchema);
