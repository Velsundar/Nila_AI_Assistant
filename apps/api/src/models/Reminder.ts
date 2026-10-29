import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const reminderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true },
    dateTime: { type: Date, required: true },
    done: { type: Boolean, default: false },
  },
  { timestamps: true },
);
reminderSchema.index({ userId: 1, done: 1, dateTime: 1 });

export type ReminderDoc = HydratedDocument<InferSchemaType<typeof reminderSchema>>;
export const ReminderModel = model("Reminder", reminderSchema);
