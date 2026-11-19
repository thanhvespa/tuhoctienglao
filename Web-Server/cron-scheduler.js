/**
 * Automation & Cron Scheduler Service.
 * Manages:
 * - Automated Drip Email Sequences (Welcome -> Habit -> Standard Offer -> Pro Upsell)
 * - Daily 20:00 Study Reminders via Telegram Bot
 * - Campaign execution logs in data/campaign_logs.json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const mailer = require("./mailer");
const crm = require("./crm");
const botService = require("./bot");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const CAMPAIGN_LOGS_FILE = path.join(DATA_DIR, "campaign_logs.json");

function ensureLogsStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(CAMPAIGN_LOGS_FILE)) {
    fs.writeFileSync(CAMPAIGN_LOGS_FILE, JSON.stringify({ logs: [] }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function recordCampaignLog(entry) {
  try {
    ensureLogsStore();
    const raw = fs.readFileSync(CAMPAIGN_LOGS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.logs)) data.logs = [];
    data.logs.unshift({
      id: "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      created_at: new Date().toISOString(),
      ...entry
    });
    if (data.logs.length > 300) data.logs.length = 300;
    const tmp = `${CAMPAIGN_LOGS_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, CAMPAIGN_LOGS_FILE);
  } catch (err) {
    console.error("[Scheduler] Error writing campaign log:", err.message);
  }
}

/**
 * Execute Drip Sequence cycle
 */
async function processDripCycle() {
  const due = crm.getDueDrips();
  const summary = { total_due: due.length, sent: 0, failed: 0, errors: [] };

  for (const item of due) {
    const { lead, nextStep, template } = item;
    try {
      let mailData = null;

      if (template === "welcome") {
        mailData = mailer.templateWelcomeLead({ email: lead.email, name: lead.name });
      } else if (template === "drip_day2") {
        mailData = mailer.templateDripDay2({ email: lead.email, name: lead.name });
      } else if (template === "offer_standard") {
        mailData = mailer.templateOfferStandard({ email: lead.email, name: lead.name });
      } else if (template === "upsell_pro") {
        mailData = mailer.templateUpsellPro({ email: lead.email, name: lead.name });
      }

      if (!mailData) continue;

      const res = await mailer.sendMail({
        to: lead.email,
        subject: mailData.subject,
        html: mailData.html,
        templateId: template,
        metadata: { lead_id: lead.id, drip_step: nextStep }
      });

      if (res.ok) {
        crm.updateLead(lead.email, {
          drip_step: nextStep,
          last_drip_sent_at: new Date().toISOString(),
          upsell_notified: template === "upsell_pro" ? true : lead.upsell_notified
        });
        summary.sent++;
      } else {
        summary.failed++;
        summary.errors.push(`${lead.email}: ${res.error || "Send error"}`);
      }
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${lead.email}: ${err.message}`);
    }
  }

  recordCampaignLog({ action: "drip_cycle", ...summary });
  return summary;
}

/**
 * Broadcast daily reminder to Telegram users with registered chat IDs
 */
async function processTelegramReminders(botToken = process.env.TELEGRAM_BOT_TOKEN) {
  if (!botToken) {
    return { ok: false, notice: "No TELEGRAM_BOT_TOKEN configured, skipped reminder broadcast" };
  }

  const leadsStore = crm.readLeads();
  const tgLeads = leadsStore.leads.filter(l => l.telegram_chat_id && !l.unsubscribed);
  const reminder = botService.getDailyReminder();
  let sentCount = 0;

  for (const lead of tgLeads) {
    try {
      await botService.dispatchTelegramOutbound(botToken, "sendMessage", {
        chat_id: lead.telegram_chat_id,
        text: reminder.message,
        reply_markup: {
          inline_keyboard: [
            [{ text: "📖 Mở App Luyện 15 Phút Ngay", url: "https://tuhoctienglao.online/Slide-Tuong-Tac/" }]
          ]
        }
      });
      sentCount++;
    } catch (err) {
      console.warn(`[Scheduler] Failed sending reminder to TG user ${lead.telegram_chat_id}:`, err.message);
    }
  }

  recordCampaignLog({ action: "telegram_reminder", total_candidates: tgLeads.length, sent: sentCount });
  return { ok: true, sent: sentCount, total: tgLeads.length };
}

/**
 * Start the background scheduler timer
 */
let timerRef = null;
function startScheduler({ intervalMs = 15 * 60 * 1000 } = {}) {
  if (timerRef) return;

  console.log(`[Scheduler] Automation Scheduler started (Cycle interval: ${Math.round(intervalMs / 60000)}m)`);
  timerRef = setInterval(async () => {
    try {
      await processDripCycle();
    } catch (err) {
      console.error("[Scheduler] Error in drip cycle timer:", err.message);
    }
  }, intervalMs);

  // Unref timer so node process can exit cleanly during tests / shutdowns
  if (timerRef.unref) timerRef.unref();
}

function stopScheduler() {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
  }
}

module.exports = {
  processDripCycle,
  processTelegramReminders,
  startScheduler,
  stopScheduler,
  recordCampaignLog,
  CAMPAIGN_LOGS_FILE
};
