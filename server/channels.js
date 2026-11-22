'use strict';
// Channels: Slack, Email (SMTP / Resend), and In-App Outbox.
const db = require('./lib/db'), { clock, id, j, sha256 } = require('./lib/util'), slack = require('./slack');
const hooks = { failNext: 0 };

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

let cachedTransporter = null;
function getTransporter() {
  if (process.env.NODE_ENV === 'test') return null;
  if (cachedTransporter) return cachedTransporter;
  if (!nodemailer || !process.env.SMTP_HOST) return null;
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: +(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD
    } : undefined,
    tls: {
      ciphers: 'SSLv3'
    }
  });
  return cachedTransporter;
}

async function sendEmail(to, subject, text) {
  // 1. Resend API
  if (process.env.RESEND_API_KEY) {
    const from = process.env.EMAIL_FROM || 'Aegis Compliance <compliance@aegis.app>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
    const out = await res.json();
    if (!res.ok) throw new Error(`Resend error: ${out.message || res.status}`);
    return out.id || 'resend-ok';
  }

  // 2. SMTP Transporter
  const transporter = getTransporter();
  if (transporter) {
    const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'compliance@aegis.app';
    const linkMatch = text.match(/https?:\/\/[^\s]+/);
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff;">
        <div style="margin-bottom: 20px;">
          <h2 style="color: #0f172a; margin: 0 0 8px 0; font-size: 20px;">Aegis Compliance Coworker</h2>
          <p style="color: #64748b; font-size: 14px; margin: 0;">Automated Compliance Notice</p>
        </div>
        <div style="line-height: 1.6; color: #334155; font-size: 15px; margin-bottom: 24px; white-space: pre-line;">
          ${text.replace(/(https?:\/\/[^\s]+)/g, '')}
        </div>
        ${linkMatch ? `
        <div style="margin: 28px 0;">
          <a href="${linkMatch[0]}" style="display: inline-block; background-color: #059669; color: #ffffff; text-decoration: none; padding: 12px 24px; font-weight: 600; border-radius: 6px; font-size: 15px;">
            Upload Required Document
          </a>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 10px;">Or copy and paste this link in your browser: <br><a href="${linkMatch[0]}" style="color: #2563eb;">${linkMatch[0]}</a></p>
        </div>` : ''}
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
        <p style="font-size: 12px; color: #94a3b8; margin: 0;">This is an automated request from your organization's compliance team. Please do not reply directly to this email.</p>
      </div>
    `;
    const info = await transporter.sendMail({ from, to, subject, text, html });
    return info.messageId || 'smtp-ok';
  }

  return null;
}

// Message status is honest:
// - "sent": an email or Slack provider accepted the message. (Whether it reached the inbox is not known.)
// - "outbox": no email or Slack is set up for this recipient, so the message stayed inside Aegis.
// If an email or Slack provider is set up but fails, delivery throws, so the job retries and the failure is visible.
async function deliver(tenant, action, maySend = () => true) {
  if (hooks.failNext > 0) { hooks.failNext--; throw new Error('Simulated channel failure'); }
  const ch = j(tenant.channel_json, { type: 'outbox' });
  let channel = 'outbox', ref = null;

  // Try Slack: by the person's saved Slack ID, or else by their work email.
  const slackOn = ch.type === 'slack' && slack.configured(tenant.id);
  // A failed lookup (for example a missing Slack permission) falls back to email instead of blocking the message.
  const slackId = slackOn ? action.recipient_slack || await slack.findUserByEmail(tenant.id, action.recipient_email).catch((e) => { console.error('[slack] email lookup failed:', e.message); return null; }) : null;
  if (!maySend()) return 'paused';
  if (slackId) {
    ref = await slack.postMessage(tenant.id, slackId, action.body);
    channel = 'slack';
  }
  // Try Email (if recipient has an email address)
  else if (action.recipient_email || (!Object.hasOwn(action, 'recipient_email') && action.recipient?.includes('@'))) {
    const to = action.recipient_email || action.recipient;
    const emailRef = await sendEmail(to, action.subject, action.body).catch((e) => {
      throw new Error(`Email to ${to} failed: ${e.message}`);
    });
    if (emailRef) {
      channel = 'email';
      ref = emailRef;
    }
  }

  db.insert('messages', {
    id: id('msg'),
    tenant_id: tenant.id,
    action_id: action.id,
    channel,
    recipient: action.recipient,
    subject: action.subject,
    body: action.body,
    status: channel === 'outbox' ? 'outbox' : 'sent',
    provider_ref: ref,
    created_at: clock.iso()
  });
  return channel;
}

// Posts to the company's reporting channel (digests and alerts). With Slack connected it goes to
// the Slack channel; otherwise it stays in the outbox. A Slack failure throws, so it is not hidden.
async function post(tenant, recipient, subject, body) {
  const ch = j(tenant.channel_json, { type: 'outbox' });
  let channel = 'outbox', ref = null;
  if (ch.type === 'slack' && slack.configured(tenant.id)) {
    ref = await slack.postMessage(tenant.id, recipient, `**${subject}**\n${body}`);
    channel = 'slack';
  }
  db.insert('messages', {
    id: id('msg'),
    tenant_id: tenant.id,
    action_id: null,
    channel,
    recipient,
    subject,
    body,
    status: channel === 'outbox' ? 'outbox' : 'sent',
    provider_ref: ref,
    created_at: clock.iso()
  });
  return channel;
}

module.exports = { deliver, post, verifySlack: slack.verify, hooks, sha256 };
