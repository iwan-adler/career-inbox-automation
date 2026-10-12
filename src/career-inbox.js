// Career inbox: rule-based classification, extraction and reply drafting.
//
// Pure functions only (no n8n, no network), so everything is unit-tested with `node --test`.
// scripts/build-workflow.js copies this file (above the export marker) into the n8n Code nodes,
// so the workflow runs exactly the code the tests cover.

const CATEGORIES = ["internship", "event", "university", "deadline", "other"];

// Keywords per category. Subject matches count double. Edit these to fit your inbox.
const KEYWORDS = {
  internship: [
    "internship", "intern", "interns", "stipend", "ppo", "placement", "placements", "hiring",
    "job opening", "job opportunity", "recruitment", "recruiter", "interview", "online assessment",
    "coding test", "shortlisted", "offer letter", "career opportunity", "apply now", "resume", "cv",
  ],
  event: [
    "webinar", "workshop", "hackathon", "seminar", "conference", "meetup", "guest lecture",
    "bootcamp", "fest", "summit", "rsvp", "register now", "registration open", "registrations open",
    "competition", "event", "masterclass",
  ],
  university: [
    "semester", "exam", "exams", "examination", "timetable", "time table", "registrar", "academic",
    "course registration", "attendance", "fee payment", "fees", "hostel", "convocation", "results",
    "grade", "grades", "faculty", "dean", "circular", "classes", "mid-term", "end-term",
  ],
  deadline: [
    "deadline", "last date", "due date", "due on", "due by", "closes on", "closing date", "apply by",
    "submit by", "register by", "final reminder", "final call", "last chance", "expires", "reminder",
  ],
};

// Senders from these domains (or any .edu / .ac.in / .edu.in) get a boost towards "university".
const UNIVERSITY_DOMAINS = ["srmap.edu.in"];
const ACADEMIC_TLD = /\.(edu|ac\.in|edu\.in)$/i;

const MIN_SCORE = 2; // below this, an email is "other"
const NO_REPLY_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|bounce)([._-]|@)/i;
const MAX_REMEMBERED_IDS = 1000;
const MAX_LOG_ENTRIES = 200;
const SUMMARY_MAX_CHARS = 280;
const HIGH_PRIORITY_DAYS = 7;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DEADLINE_TRIGGER = /\b(deadline|last date|due|apply by|submit by|register by|close|closes|closing|ends|before|until|till|by)\b/gi;

// ---------------------------------------------------------------------------
// Normalising Gmail data
// ---------------------------------------------------------------------------

function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseAddress(value) {
  if (!value) return { name: "", address: "" };
  if (typeof value === "object") {
    // Gmail trigger with "Simplify" off: { value: [{ address, name }], text }
    const first = Array.isArray(value.value) ? value.value[0] : value;
    if (first && first.address) return { name: first.name || "", address: first.address.toLowerCase() };
    return parseAddress(value.text);
  }
  const match = String(value).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim(), address: match[2].trim().toLowerCase() };
  return { name: "", address: String(value).trim().toLowerCase() };
}

/** Accepts both Gmail trigger output shapes ("Simplify" on or off). */
function normalizeEmail(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Email item is not an object");
  const body = raw.text || htmlToText(raw.html) || raw.snippet || "";
  const dateValue = raw.date || (raw.internalDate ? Number(raw.internalDate) : null);
  const date = dateValue ? new Date(dateValue) : null;
  return {
    id: raw.id || null,
    threadId: raw.threadId || null,
    subject: String(raw.subject ?? raw.Subject ?? "").trim(),
    from: parseAddress(raw.from ?? raw.From),
    body: String(body),
    receivedAt: date && !Number.isNaN(date.getTime()) ? date : null,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((k) => new RegExp(`\\b${escapeRegex(k)}\\b`).test(lower));
}

function senderDomain(address) {
  return (address.split("@")[1] || "").toLowerCase();
}

function scoreEmail(email) {
  const scores = {};
  const matched = {};
  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    const inSubject = countKeywords(email.subject, keywords);
    const inBody = countKeywords(email.body, keywords);
    scores[category] = inSubject.length * 2 + inBody.length;
    matched[category] = [...new Set([...inSubject, ...inBody])];
  }
  const domain = senderDomain(email.from.address);
  if (UNIVERSITY_DOMAINS.includes(domain) || ACADEMIC_TLD.test(domain)) scores.university += 3;
  return { scores, matched };
}

/**
 * Topic categories win; "deadline" is used only when an email is about a deadline
 * but not about an internship, event or university matter. Ties go to the earlier category.
 */
function pickCategory(scores) {
  let best = "other";
  let bestScore = MIN_SCORE - 1;
  for (const category of ["internship", "event", "university"]) {
    if (scores[category] > bestScore) {
      best = category;
      bestScore = scores[category];
    }
  }
  if (best === "other" && scores.deadline >= MIN_SCORE) return "deadline";
  return best;
}

// ---------------------------------------------------------------------------
// Deadline extraction
// ---------------------------------------------------------------------------

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null; // e.g. 31 February
  }
  return date.toISOString().slice(0, 10);
}

function withYear(month, day, year, reference) {
  if (year) return isoDate(year < 100 ? 2000 + year : year, month, day);
  // No year given: assume the next occurrence (allowing for a week in the past).
  const refYear = reference.getUTCFullYear();
  const candidate = isoDate(refYear, month, day);
  if (!candidate) return null;
  const weekAgo = new Date(reference.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  return candidate < weekAgo ? isoDate(refYear + 1, month, day) : candidate;
}

const monthNumber = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/** Find the first date at the start of `text`. Numeric dates are read day-first (DD/MM/YYYY). */
function parseDateAtStart(text, reference) {
  const s = text.trimStart();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\b/))) return isoDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/))) return withYear(+m[2], +m[1], +m[3], reference);
  if ((m = s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?(?:\\s+(\\d{4}))?\\b`, "i")))) {
    return withYear(monthNumber(m[2]), +m[1], m[3] ? +m[3] : null, reference);
  }
  if ((m = s.match(new RegExp(`^${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?(?:\\s+(\\d{4}))?`, "i")))) {
    return withYear(monthNumber(m[1]), +m[2], m[3] ? +m[3] : null, reference);
  }
  if (/^today\b/i.test(s)) return reference.toISOString().slice(0, 10);
  if (/^tomorrow\b/i.test(s)) return new Date(reference.getTime() + 86400000).toISOString().slice(0, 10);
  return null;
}

/** Returns { date: "YYYY-MM-DD", text } for the first date that follows a deadline phrase, or null. */
function extractDeadline(text, reference = new Date()) {
  const source = String(text);
  for (const match of source.matchAll(DEADLINE_TRIGGER)) {
    const start = match.index + match[0].length;
    // Look for a date anywhere in the rest of the sentence (max 60 chars):
    // "deadline for submitting your form is 14/10/2026", "register before the 9th of December"
    const sentence = source.slice(start, start + 60).split(/\n|[.!?](?=\s|$)/)[0];
    for (const word of sentence.matchAll(/[^\s:,;()–-]+/g)) {
      const date = parseDateAtStart(sentence.slice(word.index), reference);
      if (date) {
        return { date, text: source.slice(match.index, start + sentence.length).trim() };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summarize(body, subject) {
  const lines = [];
  for (const line of String(body).split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue; // quoted reply
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^--\s*$/.test(line)) {
      break; // start of quoted thread or signature
    }
    lines.push(line);
  }
  const clean = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!clean) return subject.slice(0, SUMMARY_MAX_CHARS);

  let summary = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (summary && (summary + " " + sentence).length > SUMMARY_MAX_CHARS) break;
    summary = summary ? `${summary} ${sentence}` : sentence;
  }
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary;
}

// ---------------------------------------------------------------------------
// Validation (guards against malformed results, e.g. from a future AI step)
// ---------------------------------------------------------------------------

function validateClassification(result) {
  const problems = [];
  if (!result || typeof result !== "object") return ["result is not an object"];
  if (!CATEGORIES.includes(result.category)) problems.push(`unknown category: ${JSON.stringify(result.category)}`);
  if (typeof result.summary !== "string" || !result.summary.trim()) problems.push("summary must be a non-empty string");
  else if (result.summary.length > SUMMARY_MAX_CHARS) problems.push("summary too long");
  if (result.deadline !== null && !(typeof result.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(result.deadline))) {
    problems.push("deadline must be null or YYYY-MM-DD");
  }
  if (!["high", "normal", "low"].includes(result.priority)) problems.push("priority must be high, normal or low");
  return problems;
}

// ---------------------------------------------------------------------------
// Reply drafts (always reviewed and sent by a human in Gmail)
// ---------------------------------------------------------------------------

function greetingName(from, fallback) {
  const first = (from.name || "").split(/\s+/)[0];
  if (!first || /team|career|hr|admin|office|notification|reply|info|support|placement|cell|club/i.test(from.name)) {
    return fallback;
  }
  return first.replace(/[^\p{L}'-]/gu, "") || fallback;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}

function buildReply(analysis) {
  const { category, from, subject, deadline } = analysis;
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const due = deadline ? ` before the deadline of ${formatDate(deadline)}` : "";
  const sign = "\n\nBest regards,\n[Your Name]\n[Your Programme], SRM University-AP";

  const bodies = {
    internship:
      `Dear ${greetingName(from, "Hiring Team")},\n\n` +
      `Thank you for sharing this opportunity. I am interested and would like to apply. ` +
      `Could you please let me know the next steps${due ? " and any documents I should submit" + due : ""}?` +
      sign,
    event:
      `Dear ${greetingName(from, "Organisers")},\n\n` +
      `Thank you for the invitation. I would like to attend. Please let me know if any registration is needed from my side${due}.` +
      sign,
    deadline:
      `Dear ${greetingName(from, "Sir/Madam")},\n\n` +
      `Thank you for the reminder. I will complete this${due}.` +
      sign,
  };
  return bodies[category] ? { subject: replySubject, body: bodies[category] } : null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function analyzeEmail(email, now = new Date()) {
  const reference = email.receivedAt || now;
  const text = `${email.subject}\n${email.body}`;
  const { scores, matched } = scoreEmail(email);
  const deadline = extractDeadline(text, reference);
  if (deadline) scores.deadline += 1;
  const category = pickCategory(scores);

  const daysLeft = deadline ? Math.ceil((Date.parse(deadline.date) - now.getTime()) / 86400000) : null;
  const priority =
    category === "other" ? "low" : daysLeft !== null && daysLeft >= 0 && daysLeft <= HIGH_PRIORITY_DAYS ? "high" : "normal";

  const analysis = {
    id: email.id,
    threadId: email.threadId,
    from: email.from,
    subject: email.subject,
    receivedAt: email.receivedAt ? email.receivedAt.toISOString() : null,
    category,
    priority,
    summary: summarize(email.body, email.subject) || "(no content)",
    deadline: deadline ? deadline.date : null,
    deadlineText: deadline ? deadline.text : null,
    scores,
    matchedKeywords: matched,
  };
  const problems = validateClassification(analysis);
  if (problems.length) throw new Error(`Invalid classification: ${problems.join("; ")}`);
  return analysis;
}

function remember(list, value, max) {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * Classify a batch of Gmail items. `store` is n8n workflow static data (a plain object that
 * n8n persists between production executions); it remembers processed messages and threads.
 * Never throws: a bad email becomes an item with status "invalid" so the batch continues.
 */
function processEmails(rawEmails, store, now = new Date()) {
  store.processedIds = store.processedIds || [];
  store.draftedThreads = store.draftedThreads || [];
  const seen = new Set(store.processedIds);

  return rawEmails.map((raw) => {
    try {
      const email = normalizeEmail(raw);
      if (!email.id) throw new Error("Email has no id");
      if (seen.has(email.id)) {
        return { id: email.id, threadId: email.threadId, subject: email.subject, status: "duplicate", action: "none" };
      }
      seen.add(email.id);
      remember(store.processedIds, email.id, MAX_REMEMBERED_IDS);

      const analysis = analyzeEmail(email, now);
      const reply = buildReply(analysis);
      let status;
      if (analysis.category === "other") status = "irrelevant";
      else if (!reply) status = "no_reply_needed";
      else if (!analysis.from.address || NO_REPLY_SENDER.test(analysis.from.address)) status = "no_reply_address";
      else if (analysis.threadId && store.draftedThreads.includes(analysis.threadId)) status = "thread_already_drafted";
      else status = "draft_pending";

      if (status === "draft_pending" && analysis.threadId) {
        remember(store.draftedThreads, analysis.threadId, MAX_REMEMBERED_IDS);
      }
      return { ...analysis, reply, status, action: status === "draft_pending" ? "draft" : "none" };
    } catch (error) {
      return {
        id: raw && raw.id ? raw.id : null,
        status: "invalid",
        action: "none",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** One log line per processed email. `draftOutput` is the Gmail node's output (or error). */
function buildStatusRecord(email, draftOutput, now = new Date()) {
  let status = email.status;
  let draftId = null;
  let error = email.error || null;
  if (email.action === "draft") {
    if (draftOutput && draftOutput.error) {
      status = "draft_failed";
      error = typeof draftOutput.error === "string" ? draftOutput.error : draftOutput.error.message || JSON.stringify(draftOutput.error);
    } else if (draftOutput && draftOutput.id) {
      status = "drafted";
      draftId = draftOutput.id;
    } else {
      status = "draft_failed";
      error = "Gmail returned no draft id";
    }
  }
  return {
    messageId: email.id || null,
    threadId: email.threadId || null,
    receivedAt: email.receivedAt || null,
    from: email.from ? email.from.address : null,
    subject: email.subject || null,
    category: email.category || null,
    priority: email.priority || null,
    deadline: email.deadline || null,
    summary: email.summary || null,
    status,
    draftId,
    error,
    recordedAt: now.toISOString(),
  };
}

function appendLog(store, record) {
  store.log = store.log || [];
  remember(store.log, record, MAX_LOG_ENTRIES);
}

// ---- n8n:exclude-below ---- (build script stops copying here)
module.exports = {
  CATEGORIES,
  normalizeEmail,
  parseAddress,
  htmlToText,
  scoreEmail,
  pickCategory,
  extractDeadline,
  summarize,
  validateClassification,
  buildReply,
  analyzeEmail,
  processEmails,
  buildStatusRecord,
  appendLog,
};
