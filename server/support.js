import nodemailer from "nodemailer";
import { now } from "./core.js";

export const validSupportEmail = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(value);

export const supportConfigured = (cfg) =>
  !cfg.testMode &&
  !!cfg.smtp &&
  !!cfg.smtpFrom &&
  validSupportEmail(cfg.supportEmail);

// Tickets remain durable when SMTP is unavailable. Retry explicitly through
// the operator command; an SMTP acceptance is not proof of inbox receipt.
export async function deliverSupport(db, cfg, id) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
  if (!ticket) throw Error("Support ticket not found.");
  if (ticket.delivery === "accepted") return "accepted";
  if (!supportConfigured(cfg) || !validSupportEmail(ticket.email))
    return "unavailable";
  const transport = nodemailer.createTransport({
    url: cfg.smtp,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    const result = await transport.sendMail({
      from: cfg.smtpFrom,
      to: cfg.supportEmail,
      replyTo: ticket.email,
      subject: `[Anonyma support ${ticket.id}] ${ticket.subject.replace(/[\r\n]/g, " ")}`,
      text: `Support ticket: ${ticket.id}\nAccount: ${ticket.user_id || "Signed-out visitor (identity unverified)"}\nReply address (user supplied): ${ticket.email}\n\n${ticket.body}`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!result.accepted?.length || result.rejected?.length)
      throw Error("Recipient not accepted.");
    db.prepare(
      "UPDATE tickets SET delivery='accepted',delivered_at=? WHERE id=?",
    ).run(now(), id);
    return "accepted";
  } catch {
    // Do not log SMTP errors: they may contain credentials or message content.
    db.prepare("UPDATE tickets SET delivery='failed' WHERE id=?").run(id);
    return "failed";
  } finally {
    transport.close();
  }
}
