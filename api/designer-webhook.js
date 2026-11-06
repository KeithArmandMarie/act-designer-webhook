// Vercel serverless function.
// Receives the ACT Online Designer webhook (POST, JSON) and sends the lead
// to a HubSpot form, which creates or updates the contact in HubSpot.
// Put this file in your project at: api/designer-webhook.js
//
// Environment variables (set in Vercel):
//   HUBSPOT_PORTAL_ID   the number from your HubSpot embed code (portalId)
//   HUBSPOT_FORM_GUID   the long id from your HubSpot embed code (formId)
//   WEBHOOK_SECRET      a long random string, also used in the webhook URL

const crypto = require("crypto");

const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const FORM_GUID = process.env.HUBSPOT_FORM_GUID;
const SECRET = process.env.WEBHOOK_SECRET;

function clean(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function yesNo(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return clean(value);
}

function safeEqual(a, b) {
  const x = Buffer.from(clean(a));
  const y = Buffer.from(clean(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function withProtocol(url) {
  const u = clean(url);
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}

// Turns the designer payload into one readable note for the HubSpot Message field.
function buildMessage(p) {
  const lines = ["New quote request from the ACT Online Designer", ""];
  const add = (label, value) => {
    const v = clean(value);
    if (v) lines.push(label + ": " + v);
  };

  add("Customer notes", p.Details);
  add("Finance arranged", yesNo(p.IsFinanceArranged));
  add("Land owned", yesNo(p.IsLandOwned));
  add("Planned construction date", p.PlannedConstructionDate);
  add("County", p.County);

  (p.QuoteQuestionResponses || []).forEach((q) =>
    add(clean(q.Question) || "Question", q.Response)
  );

  // Building details: only groups of simple values (width, length, colors, etc).
  const building = p.BuildingDescription || {};
  Object.keys(building).forEach((section) => {
    const group = building[section];
    if (group && typeof group === "object" && !Array.isArray(group)) {
      lines.push("", section + ":");
      Object.keys(group).forEach((key) => {
        const v = group[key];
        if (v !== null && typeof v !== "object") {
          lines.push("  " + key + ": " + v);
        }
      });
    }
  });

  lines.push("");
  add("Designer link", p.OnlineDesignerBuildingUrl);
  add("Building file download", p.ActBuildingFileDownloadUrl);
  add("Screenshot A", p.ScreenshotAUrl);
  add("Screenshot B", p.ScreenshotBUrl);
  add("ACT lead page", withProtocol(p.LeadUrl));
  add("ACT lead ID", p.LeadId);
  add("Distributor", p.DistributorName);

  // Shows where the visitor came from, if the designer link passed UTM or gclid values.
  const qs = p.QueryStringParameters || {};
  const qsLines = Object.keys(qs)
    .filter((k) => qs[k] !== null && qs[k] !== "")
    .map((k) => "  " + k + ": " + qs[k]);
  if (qsLines.length) {
    lines.push("", "Query string values:", ...qsLines);
  }

  return lines.join("\n").slice(0, 60000);
}

// Fake lead used for the browser test (GET with ?test=your@email.com).
function samplePayload(email) {
  return {
    LeadId: 0,
    NameFirst: "Test",
    NameLast: "Lead",
    EmailAddress: email,
    PhoneNumber: "5555550100",
    Company: "Test Company",
    Address: "123 Test Street",
    City: "Sample City",
    State: "TX",
    Zip: "12345",
    Details: "Test lead from the webhook endpoint",
    BuildingDescription: {
      "Main Building Dimensions": { Width: "40'", Length: "60'", "Eave Height": "14'" },
    },
    QueryStringParameters: { utm_source: "test" },
  };
}

module.exports = async (req, res) => {
  if (!SECRET || !PORTAL_ID || !FORM_GUID) {
    console.error("Missing environment variables");
    return res.status(500).json({ error: "server not configured" });
  }

  if (!safeEqual(req.query.key, SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let payload;
  if (req.method === "GET" && req.query.test) {
    payload = samplePayload(String(req.query.test));
  } else if (req.method === "POST") {
    try {
      payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      return res.status(400).json({ error: "invalid JSON" });
    }
  } else {
    return res.status(405).json({ error: "method not allowed" });
  }

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "empty payload" });
  }

  // HubSpot needs an email to create a contact. Retrying would not fix this,
  // so answer 200 and log it. The lead still exists in the ACT system.
  if (!clean(payload.EmailAddress)) {
    console.error("No email on lead", payload.LeadId);
    return res.status(200).json({ skipped: "no email" });
  }

  const map = {
    email: payload.EmailAddress,
    firstname: payload.NameFirst,
    lastname: payload.NameLast,
    phone: payload.PhoneNumber,
    company: payload.Company,
    address: payload.Address,
    city: payload.City,
    state: payload.State,
    zip: payload.Zip,
    message: buildMessage(payload),
  };

  const fields = Object.keys(map)
    .filter((name) => clean(map[name]))
    .map((name) => ({ objectTypeId: "0-1", name, value: clean(map[name]) }));

  const url =
    "https://api.hsforms.com/submissions/v3/integration/submit/" +
    PORTAL_ID +
    "/" +
    FORM_GUID;

  const body = {
    submittedAt: Date.now(),
    fields,
    context: {
      pageUri:
        withProtocol(payload.OnlineDesignerBuildingUrl) ||
        "https://designer.actbuildingsystems.com/",
      pageName: "ACT Online Designer Quote",
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (r.ok) {
      console.log("Lead sent to HubSpot", payload.LeadId);
      return res.status(200).json({ ok: true });
    }

    const text = await r.text();
    console.error("HubSpot error", r.status, text.slice(0, 500), "lead", payload.LeadId);

    // Temporary problem: answer 502 so the designer retries later.
    if (r.status === 429 || r.status >= 500) {
      return res.status(502).json({ error: "retry later" });
    }
    // Permanent problem (bad field, blocked email): retrying will not help.
    return res.status(200).json({ error: "rejected by HubSpot, not retrying" });
  } catch (e) {
    console.error("HubSpot request failed", e.message, "lead", payload.LeadId);
    return res.status(502).json({ error: "retry later" });
  } finally {
    clearTimeout(timer);
  }
};
