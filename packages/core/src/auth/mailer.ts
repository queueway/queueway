import nodemailer from "nodemailer";
import path from "path";
import { logger } from "../logging/Logger";

function getTransporter() {
  const host = process.env.QUEUEWAY_SMTP_HOST;
  const port = Number(process.env.QUEUEWAY_SMTP_PORT || 465);
  const user = process.env.QUEUEWAY_SMTP_USER;
  const pass = process.env.QUEUEWAY_SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.png");

// Emails are always sent in a light theme, regardless of the dashboard's
// current theme — dark-themed HTML emails render inconsistently (or badly)
// across email clients (Outlook, Gmail on some devices, etc.), so light is
// the safe, reliable choice here.
function emailShell(bodyHtml: string): string {
  return `
  <div style="background:#f3f4f6;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="padding:28px 32px 0;text-align:center;">
        <img src="cid:queueway-logo" alt="Queueway" width="140" style="display:inline-block;" />
      </div>
      <div style="padding:16px 32px 32px;color:#1f2937;font-size:14px;line-height:1.6;">
        ${bodyHtml}
      </div>
      <div style="padding:16px 32px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;text-align:center;">
        Powered by <a href="https://www.instagram.com/modestick.official" style="color:#4b5563;font-weight:600;text-decoration:none;">Modestick</a>
      </div>
    </div>
  </div>`;
}

function withAttachments(html: string) {
  return {
    html,
    attachments: [
      {
        filename: "logo.png",
        path: LOGO_PATH,
        cid: "queueway-logo",
      },
    ],
  };
}

/** Sent once, right after signup. Contains the password since this is the
 * only moment we ever have it in plaintext — it's hashed immediately after. */
export async function sendWelcomeEmail(toEmail: string, password: string): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn("⚠️  SMTP not configured — skipping welcome email. Set QUEUEWAY_SMTP_* env vars to enable it.");
    return;
  }

  const bodyHtml = `
    <h2 style="color:#111827;font-size:18px;margin:0 0 12px;">Welcome to your Queueway dashboard 🎉</h2>
    <p>Your dashboard account has been created. Here are your login details:</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 6px;"><strong>Email:</strong> ${toEmail}</p>
      <p style="margin:0;"><strong>Password:</strong> ${password}</p>
    </div>
    <p style="color:#6b7280;">Keep this email somewhere safe — it's the only time your password will be sent in plain text. If you ever forget it, use "Forgot password" on the login page instead of searching for this email again.</p>
  `;

  const admin = process.env.QUEUEWAY_ADMIN_EMAIL || process.env.QUEUEWAY_SMTP_USER;

  try {
    await transporter.sendMail({
      from: `"Queueway" <${process.env.QUEUEWAY_SMTP_USER}>`,
      to: toEmail,
      cc: admin,
      subject: "Welcome to Queueway — your dashboard is ready",
      ...withAttachments(emailShell(bodyHtml)),
    });
    logger.info(`📧 Welcome email sent to ${toEmail}`);
  } catch (err: any) {
    logger.error("Failed to send welcome email", { error: err?.message ?? String(err) });
  }
}

/** Sent when a user requests a password reset. Contains a one-time link, not the password. */
export async function sendPasswordResetEmail(toEmail: string, resetUrl: string): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn("⚠️  SMTP not configured — skipping password reset email.");
    return;
  }

  const bodyHtml = `
    <h2 style="color:#111827;font-size:18px;margin:0 0 12px;">Reset your Queueway password</h2>
    <p>Someone (hopefully you) asked to reset the password for this account. Click below to set a new one:</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${resetUrl}" style="background:linear-gradient(90deg,#ea580c,#4d9eff);color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:600;display:inline-block;">Set a new password</a>
    </p>
    <p style="color:#6b7280;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
  `;

  try {
    await transporter.sendMail({
      from: `"Queueway" <${process.env.QUEUEWAY_SMTP_USER}>`,
      to: toEmail,
      subject: "Reset your Queueway password",
      ...withAttachments(emailShell(bodyHtml)),
    });
    logger.info(`📧 Password reset email sent to ${toEmail}`);
  } catch (err: any) {
    logger.error("Failed to send password reset email", { error: err?.message ?? String(err) });
  }
}
