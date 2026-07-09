import { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { AuthStore } from "./AuthStore";
import { sendWelcomeEmail, sendPasswordResetEmail } from "./mailer";
import { logger } from "../logging/Logger";

const SESSION_COOKIE = "queueway_session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function registerAuthRoutes(app: Express, authStore: AuthStore) {
  app.get("/auth/status", async (_req, res) => {
    res.json({ hasAccount: await authStore.hasAnyUser() });
  });

  app.post("/auth/signup", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body ?? {};
      if (!email || !password || !isValidEmail(email)) {
        return res.status(400).json({ error: "Valid email and password are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      // Single-admin dashboard: once an account exists, signup is closed.
      if (await authStore.hasAnyUser()) {
        return res.status(409).json({ error: "An account already exists — please log in instead" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await authStore.createUser(email, passwordHash);

      const token = await authStore.createSession(user.id);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: COOKIE_MAX_AGE_MS,
      });

      // Fire-and-forget — don't block signup on email delivery.
      sendWelcomeEmail(user.email, password).catch(() => {});

      res.json({ ok: true, email: user.email });
    } catch (err: any) {
      logger.error("Signup failed", { error: err?.message ?? String(err) });
      res.status(500).json({ error: "Signup failed" });
    }
  });

  app.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body ?? {};
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const user = await authStore.findUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = await authStore.createSession(user.id);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: COOKIE_MAX_AGE_MS,
      });

      res.json({ ok: true, email: user.email });
    } catch (err: any) {
      logger.error("Login failed", { error: err?.message ?? String(err) });
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/auth/logout", async (req: Request, res: Response) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await authStore.deleteSession(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get("/auth/me", async (req: Request, res: Response) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = token ? await authStore.findSessionUser(token) : null;
    if (!user) return res.status(401).json({ error: "Not logged in" });
    res.json({ email: user.email });
  });

  app.post("/auth/forgot-password", async (req: Request, res: Response) => {
    const { email } = req.body ?? {};
    const user = email ? await authStore.findUserByEmail(email) : null;

    // Always respond success — never reveal whether an email is registered.
    if (user) {
      const token = await authStore.createPasswordReset(user.id);
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${baseUrl}/?resetToken=${token}`;
      sendPasswordResetEmail(user.email, resetUrl).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.post("/auth/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body ?? {};
      if (!token || !password || password.length < 8) {
        return res.status(400).json({ error: "A valid token and an 8+ character password are required" });
      }
      const userId = await authStore.consumePasswordReset(token);
      if (!userId) {
        return res.status(400).json({ error: "This reset link is invalid or has expired" });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      await authStore.updatePassword(userId, passwordHash);
      res.json({ ok: true });
    } catch (err: any) {
      logger.error("Reset password failed", { error: err?.message ?? String(err) });
      res.status(500).json({ error: "Could not reset password" });
    }
  });
}

/** Protects the /queueway/* API — requires a valid session cookie. */
export function requireAuth(authStore: AuthStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = token ? await authStore.findSessionUser(token) : null;
    if (!user) {
      return res.status(401).json({ error: "Not logged in" });
    }
    next();
  };
}
