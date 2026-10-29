import { Router } from "express";
import { LoginSchema, RegisterSchema, UpdateMeSchema } from "@nova/shared";
import { UserModel } from "../models/User";
import { ah, HttpError, parse } from "../errors";
import { requireAuth } from "../middleware/auth";
import { hashPassword, signToken, verifyPassword } from "../services/auth";
import { toUser } from "../services/serialize";
import { geocodeCity, WeatherError } from "../services/weather";

export const authRouter = Router();

authRouter.post(
  "/register",
  ah(async (req, res) => {
    const input = parse(RegisterSchema, req.body);
    const email = input.email.trim().toLowerCase();
    if (await UserModel.exists({ email })) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
    let user;
    try {
      user = await UserModel.create({ name: input.name.trim(), email, passwordHash: await hashPassword(input.password) });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
      throw e;
    }
    res.status(201).json({ token: signToken(user._id.toString(), user.tokenVersion ?? 0), user: toUser(user) });
  }),
);

authRouter.post(
  "/login",
  ah(async (req, res) => {
    const input = parse(LoginSchema, req.body);
    const user = await UserModel.findOne({ email: input.email.trim().toLowerCase() });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect email or password");
    }
    res.json({ token: signToken(user._id.toString(), user.tokenVersion ?? 0), user: toUser(user) });
  }),
);

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: toUser(req.user!) });
});

authRouter.patch(
  "/me",
  requireAuth,
  ah(async (req, res) => {
    const input = parse(UpdateMeSchema, req.body);
    const user = req.user!;
    if (input.name !== undefined) user.name = input.name.trim();
    if (input.currency !== undefined) user.currency = input.currency.toUpperCase();
    if (input.assistantName !== undefined) user.assistantName = input.assistantName.trim();
    if (input.city !== undefined) {
      const city = input.city.trim();
      if (!city) {
        user.city = undefined;
        user.cityLat = undefined;
        user.cityLon = undefined;
      } else {
        let place;
        try {
          place = await geocodeCity(city);
        } catch (e) {
          if (e instanceof WeatherError) throw new HttpError(503, "GEOCODING_UNAVAILABLE", "Couldn't look up that city right now, try again");
          throw e;
        }
        if (!place) {
          throw new HttpError(400, "VALIDATION_ERROR", `Unknown city "${city}"`, { fieldErrors: { city: ["Unknown city"] } });
        }
        user.city = place.name;
        user.cityLat = place.lat;
        user.cityLon = place.lon;
      }
    }
    await user.save();
    res.json({ user: toUser(user) });
  }),
);

/** Sign out everywhere: bumps tokenVersion so every existing JWT (including this one) stops working. */
authRouter.post(
  "/logout-all",
  requireAuth,
  ah(async (req, res) => {
    await UserModel.updateOne({ _id: req.user!._id }, { $inc: { tokenVersion: 1 } });
    res.status(204).end();
  }),
);
