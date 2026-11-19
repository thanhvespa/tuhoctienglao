/**
 * CRM & Lead Management Service for Customer Care & Upsell Funnel.
 * 
 * Tracks:
 * - Leads (Free trial registrations from Landing Page, Telegram, Zalo)
 * - Conversion lifecycle: free_trial -> standard -> pro -> inactive
 * - Automated Drip progression (Day 0, Day 1, Day 3, Day 5, Day 7)
 * - Telegram & Zalo channel linking for omnichannel broadcast & reminders.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const LEADS_FILE = path.join(DATA_DIR, "leads.json");

function ensureLeadsStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(LEADS_FILE)) {
    // Leads hold personal data (email, phone): owner-only permissions.
    fs.writeFileSync(LEADS_FILE, JSON.stringify({ leads: [], updated_at: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function readLeads() {
  ensureLeadsStore();
  try {
    const raw = fs.readFileSync(LEADS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.leads)) parsed.leads = [];
    return parsed;
  } catch (err) {
    console.error("[CRM] Error reading leads:", err.message);
    return { leads: [], updated_at: new Date().toISOString() };
  }
}

function writeLeads(store) {
  ensureLeadsStore();
  const tmp = `${LEADS_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  store.updated_at = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, LEADS_FILE);
}

/**
 * Record a new lead or update an existing one
 */
function recordLead({ email, name, phone_zalo, telegram_chat_id, source = "landing_page" }) {
  if (!email || !email.includes("@")) {
    throw new Error("Invalid email address");
  }
  const cleanEmail = email.trim().toLowerCase();
  const store = readLeads();
  let lead = store.leads.find(l => l.email === cleanEmail);

  const now = new Date().toISOString();

  if (lead) {
    if (name && !lead.name) lead.name = name.trim();
    if (phone_zalo) lead.phone_zalo = phone_zalo.trim();
    if (telegram_chat_id) lead.telegram_chat_id = String(telegram_chat_id);
    lead.last_active_at = now;
    lead.interaction_count = (lead.interaction_count || 1) + 1;
  } else {
    lead = {
      id: "lead_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      email: cleanEmail,
      name: name ? name.trim() : cleanEmail.split("@")[0],
      phone_zalo: phone_zalo ? phone_zalo.trim() : null,
      telegram_chat_id: telegram_chat_id ? String(telegram_chat_id) : null,
      status: "free_trial", // free_trial | standard | pro | inactive
      source,
      drip_step: 0, // 0 = welcome sent, 1 = day 1 pimsleur, 2 = day 3 std offer, 3 = day 5 upsell pro, 4 = day 7 re-engage
      last_drip_sent_at: null,
      upsell_notified: false,
      unsubscribed: false,
      created_at: now,
      last_active_at: now,
      interaction_count: 1
    };
    store.leads.push(lead);
  }

  writeLeads(store);
  return lead;
}

/**
 * Update lead by email
 */
function updateLead(email, fields) {
  if (!email) return null;
  const cleanEmail = email.trim().toLowerCase();
  const store = readLeads();
  const lead = store.leads.find(l => l.email === cleanEmail);
  if (!lead) return null;

  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    lead[k] = v;
  }
  lead.last_active_at = new Date().toISOString();
  writeLeads(store);
  return lead;
}

/**
 * Sync status when user signs up or activates license
 */
function syncUserTier(email, tier) {
  if (!email) return null;
  const cleanEmail = email.trim().toLowerCase();
  const store = readLeads();
  let lead = store.leads.find(l => l.email === cleanEmail);

  const targetStatus = tier === "pro" ? "pro" : (tier === "standard" ? "standard" : "free_trial");

  if (!lead) {
    return recordLead({ email: cleanEmail, source: "license_activation" });
  }

  lead.status = targetStatus;
  lead.last_active_at = new Date().toISOString();
  writeLeads(store);
  return lead;
}

/**
 * Unsubscribe a lead from email campaigns
 */
function unsubscribeLead(email) {
  return updateLead(email, { unsubscribed: true, unsubscribed_at: new Date().toISOString() });
}

/**
 * Find leads due for drip email sequence
 */
function getDueDrips() {
  const store = readLeads();
  const now = Date.now();
  const due = [];

  for (const lead of store.leads) {
    if (lead.unsubscribed) continue;

    const createdAt = new Date(lead.created_at).getTime();
    const lastSentAt = lead.last_drip_sent_at ? new Date(lead.last_drip_sent_at).getTime() : 0;
    const hoursSinceCreated = (now - createdAt) / (1000 * 60 * 60);
    const hoursSinceLastDrip = (now - lastSentAt) / (1000 * 60 * 60);

    // Step 0: Welcome lead (within 1 hour of creation if not sent yet)
    if (lead.drip_step === 0 && !lead.last_drip_sent_at) {
      due.push({ lead, nextStep: 0, template: "welcome" });
      continue;
    }

    // Step 1: Day 1 Pimsleur Habit (approx 24h after creation, minimum 18h after step 0)
    if (lead.drip_step === 0 && hoursSinceCreated >= 20 && hoursSinceLastDrip >= 18) {
      due.push({ lead, nextStep: 1, template: "drip_day2" });
      continue;
    }

    // Step 2: Day 3 Standard Offer (approx 68-72h after creation, only for free_trial leads)
    if (lead.drip_step === 1 && lead.status === "free_trial" && hoursSinceCreated >= 68 && hoursSinceLastDrip >= 24) {
      due.push({ lead, nextStep: 2, template: "offer_standard" });
      continue;
    }

    // Step 3: Day 5 Upsell Pro (For Standard leads who haven't upgraded yet)
    if ((lead.drip_step === 2 || lead.status === "standard") && lead.status === "standard" && !lead.upsell_notified && hoursSinceLastDrip >= 48) {
      due.push({ lead, nextStep: 3, template: "upsell_pro" });
      continue;
    }
  }

  return due;
}

module.exports = {
  recordLead,
  updateLead,
  syncUserTier,
  unsubscribeLead,
  readLeads,
  getDueDrips,
  LEADS_FILE
};
