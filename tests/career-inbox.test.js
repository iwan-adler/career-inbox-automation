const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const samples = require("../examples/sample-emails.json");
const lib = require("../src/career-inbox.js");

const NOW = new Date("2026-10-12T12:00:00Z");
const REF = new Date("2026-10-12T10:00:00Z");

describe("sample emails end to end", () => {
  const results = lib.processEmails(samples, {}, NOW);

  for (const [index, sample] of samples.entries()) {
    test(`${sample.id} -> ${sample._expected.category}`, () => {
      const result = results[index];
      assert.equal(result.category, sample._expected.category);
      assert.equal(result.deadline, sample._expected.deadline);
      assert.equal(result.status, sample._expected.status);
      assert.equal(result.action, sample._expected.status === "draft_pending" ? "draft" : "none");
    });
  }

  test("extracts sender and subject", () => {
    assert.deepEqual(results[0].from, { name: "Priya Sharma", address: "priya.sharma@example-tech.com" });
    assert.equal(results[0].subject, "Summer Internship 2027 – Backend Engineering Intern");
  });

  test("summaries are short and come from the body", () => {
    for (const r of results) assert.ok(r.summary.length > 0 && r.summary.length <= 280, r.summary);
    assert.match(results[1].summary, /hands-on workshop/); // from HTML
  });
});

describe("normalizeEmail", () => {
  test("handles the simplified Gmail trigger shape", () => {
    const email = lib.normalizeEmail({
      id: "a", threadId: "t", Subject: "Hello", From: "Asha Rao <ASHA@Example.com>",
      snippet: "short preview", internalDate: "1760263200000",
    });
    assert.equal(email.subject, "Hello");
    assert.deepEqual(email.from, { name: "Asha Rao", address: "asha@example.com" });
    assert.equal(email.body, "short preview");
    assert.ok(email.receivedAt instanceof Date);
  });

  test("tolerates missing fields", () => {
    const email = lib.normalizeEmail({ id: "x" });
    assert.equal(email.subject, "");
    assert.equal(email.from.address, "");
    assert.equal(email.receivedAt, null);
  });

  test("invalid dates become null", () => {
    assert.equal(lib.normalizeEmail({ id: "x", date: "not a date" }).receivedAt, null);
  });

  test("rejects non-objects", () => {
    assert.throws(() => lib.normalizeEmail(null), /not an object/);
  });

  test("htmlToText drops scripts, styles and tags", () => {
    const text = lib.htmlToText("<style>p{}</style><p>Hi&nbsp;&amp; welcome</p><script>alert(1)</script>");
    assert.equal(text.replace(/\s+/g, " ").trim(), "Hi & welcome");
  });
});

describe("classification", () => {
  const classify = (subject, body, from = "someone@example.com") =>
    lib.analyzeEmail(lib.normalizeEmail({ id: "1", subject, text: body, from }), NOW).category;

  test("subject keywords outweigh body keywords", () => {
    assert.equal(classify("Hackathon this weekend", "Interns welcome to join the event"), "event");
  });

  test("academic sender domains count as university", () => {
    assert.equal(classify("Water supply notice", "Maintenance on Friday.", "warden@srmap.edu.in"), "university");
    assert.equal(classify("Library hours", "Open late.", "office@iit.ac.in"), "university");
    assert.equal(classify("Library hours", "Open late.", "office@library.com"), "other");
  });

  test("internship keywords beat an academic domain", () => {
    assert.equal(classify("Internship opening", "Research intern needed.", "prof@srmap.edu.in"), "internship");
  });

  test("keywords match whole words only", () => {
    // "international" contains "intern"; "eventually" contains "event"
    assert.equal(classify("International news", "Eventually it rained."), "other");
  });

  test("weak signal is other", () => {
    assert.equal(classify("Quick question", "Is there an event?"), "other");
  });

  test("deadline-only emails get the deadline category", () => {
    assert.equal(classify("Reminder", "Please submit by 20/10/2026."), "deadline");
  });

  test("topic wins over deadline", () => {
    assert.equal(classify("Internship application deadline", "Apply by 20 Oct for the internship."), "internship");
  });

  test("priority: high within 7 days, normal later, low for other", () => {
    const run = (body) => lib.analyzeEmail(lib.normalizeEmail({ id: "1", subject: "Internship", text: body }), NOW).priority;
    assert.equal(run("Internship applications close on 15 Oct 2026."), "high");
    assert.equal(run("Internship applications close on 30 Nov 2026."), "normal");
    assert.equal(run("Internship applications closed on 1 Oct 2026."), "normal"); // past deadline
    assert.equal(lib.analyzeEmail(lib.normalizeEmail({ id: "1", subject: "hi", text: "hello" }), NOW).priority, "low");
  });
});

describe("extractDeadline", () => {
  const cases = [
    ["The last date to apply is 20 October 2026.", "2026-10-20"],
    ["Deadline: 25/10/2026", "2026-10-25"],
    ["Deadline - 5.11.26", "2026-11-05"],
    ["Apply by Oct 30th", "2026-10-30"],
    ["Apply by October 30, 2026", "2026-10-30"],
    ["due date: 2026-11-01", "2026-11-01"],
    ["Submit by tomorrow", "2026-10-13"],
    ["Registrations close on 3rd Nov", "2026-11-03"],
    ["Register before the 9th of December", "2026-12-09"],
    ["The deadline for submitting your form is 14/10/2026.", "2026-10-14"],
    ["Register before 9th of December", "2026-12-09"],
    ["Apply before 5 Jan", "2027-01-05"], // month already passed -> next year
    ["Deadline 10 Oct", "2026-10-10"], // within the last week -> this year
  ];
  for (const [text, expected] of cases) {
    test(JSON.stringify(text), () => {
      const result = lib.extractDeadline(text, REF);
      assert.equal(result ? result.date : null, expected);
    });
  }

  test("ignores dates without a deadline phrase", () => {
    assert.equal(lib.extractDeadline("The fest was held on 3 Oct 2026.", REF), null);
  });

  test("ignores impossible dates", () => {
    assert.equal(lib.extractDeadline("deadline is 31/02/2026", REF), null);
  });

  test("ignores numbers that aren't dates", () => {
    assert.equal(lib.extractDeadline("organised by 5 clubs", REF), null);
  });

  test("does not look past the end of the sentence", () => {
    assert.equal(lib.extractDeadline("Apply soon. The fest is on 3 Nov 2026.", REF), null);
  });

  test("returns the matched text for context", () => {
    assert.match(lib.extractDeadline("Hello.\nDeadline: 25/10/2026 at 5pm", REF).text, /^Deadline: 25\/10\/2026/);
  });
});

describe("summarize", () => {
  test("drops quoted replies and signatures", () => {
    const body = "Thanks for applying.\nWe will reply soon.\n--\nHR Team\n> old message";
    assert.equal(lib.summarize(body, "s"), "Thanks for applying. We will reply soon.");
  });

  test("stops at 'On ... wrote:'", () => {
    assert.equal(lib.summarize("Sounds good.\nOn Mon, Asha wrote:\nearlier text", "s"), "Sounds good.");
  });

  test("caps length", () => {
    const long = "word ".repeat(200);
    assert.ok(lib.summarize(long, "s").length <= 280);
  });

  test("falls back to the subject", () => {
    assert.equal(lib.summarize("   ", "Just a subject"), "Just a subject");
  });
});

describe("validateClassification", () => {
  const valid = { category: "event", summary: "ok", deadline: null, priority: "normal" };

  test("accepts a valid result", () => {
    assert.deepEqual(lib.validateClassification(valid), []);
    assert.deepEqual(lib.validateClassification({ ...valid, deadline: "2026-10-20" }), []);
  });

  for (const [label, bad] of [
    ["not an object", "event"],
    ["unknown category", { ...valid, category: "spam" }],
    ["empty summary", { ...valid, summary: " " }],
    ["long summary", { ...valid, summary: "x".repeat(281) }],
    ["bad date", { ...valid, deadline: "20 Oct" }],
    ["bad priority", { ...valid, priority: "urgent" }],
  ]) {
    test(`rejects ${label}`, () => assert.ok(lib.validateClassification(bad).length > 0));
  }
});

describe("buildReply", () => {
  const analysis = (overrides) => ({
    category: "internship", subject: "Internship", deadline: null,
    from: { name: "Priya Sharma", address: "p@example.com" }, ...overrides,
  });

  test("uses the sender's first name and keeps placeholders for the human to fill in", () => {
    const reply = lib.buildReply(analysis());
    assert.equal(reply.subject, "Re: Internship");
    assert.match(reply.body, /^Dear Priya,/);
    assert.match(reply.body, /\[Your Name\]/);
  });

  test("generic greeting for team senders", () => {
    assert.match(lib.buildReply(analysis({ from: { name: "Careers Team", address: "c@x.com" } })).body, /^Dear Hiring Team,/);
  });

  test("mentions the deadline", () => {
    assert.match(lib.buildReply(analysis({ deadline: "2026-10-20" })).body, /20 October 2026/);
  });

  test("does not double the Re: prefix", () => {
    assert.equal(lib.buildReply(analysis({ subject: "RE: Interview" })).subject, "RE: Interview");
  });

  test("no reply for university notices or other", () => {
    assert.equal(lib.buildReply(analysis({ category: "university" })), null);
    assert.equal(lib.buildReply(analysis({ category: "other" })), null);
  });
});

describe("processEmails: duplicates and failures", () => {
  const internship = samples[0];

  test("same message is processed only once across runs", () => {
    const store = {};
    assert.equal(lib.processEmails([internship], store, NOW)[0].status, "draft_pending");
    assert.equal(lib.processEmails([internship], store, NOW)[0].status, "duplicate");
  });

  test("duplicate inside one batch", () => {
    const [first, second] = lib.processEmails([internship, internship], {}, NOW);
    assert.equal(first.status, "draft_pending");
    assert.equal(second.status, "duplicate");
  });

  test("only one draft per thread", () => {
    const followUp = { ...internship, id: "msg-internship-2" };
    const [first, second] = lib.processEmails([internship, followUp], {}, NOW);
    assert.equal(first.action, "draft");
    assert.equal(second.status, "thread_already_drafted");
    assert.equal(second.action, "none");
  });

  test("a broken email doesn't stop the batch", () => {
    const results = lib.processEmails([null, { subject: "no id" }, internship], {}, NOW);
    assert.equal(results[0].status, "invalid");
    assert.equal(results[1].status, "invalid");
    assert.match(results[1].error, /no id/);
    assert.equal(results[2].status, "draft_pending");
  });

  test("remembered ids are capped", () => {
    const store = { processedIds: Array.from({ length: 1000 }, (_, i) => `old-${i}`) };
    lib.processEmails([internship], store, NOW);
    assert.equal(store.processedIds.length, 1000);
    assert.equal(store.processedIds.at(-1), internship.id);
    assert.ok(!store.processedIds.includes("old-0"));
  });

  test("never drafts to no-reply style senders", () => {
    for (const address of ["noreply@x.com", "no-reply@x.com", "do-not-reply@x.com", "notifications@x.com", "jobs.noreply@x.com"]) {
      const email = { ...internship, id: address, threadId: address, from: `X <${address}>` };
      assert.equal(lib.processEmails([email], {}, NOW)[0].status, "no_reply_address", address);
    }
  });
});

describe("buildStatusRecord", () => {
  const [drafted, , university] = lib.processEmails(samples, {}, NOW);

  test("drafted when Gmail returns a draft id", () => {
    const record = lib.buildStatusRecord(drafted, { id: "r-123", message: {} }, NOW);
    assert.equal(record.status, "drafted");
    assert.equal(record.draftId, "r-123");
    assert.equal(record.category, "internship");
  });

  test("draft_failed when Gmail returns an error", () => {
    const record = lib.buildStatusRecord(drafted, { error: { message: "Invalid credentials" } }, NOW);
    assert.equal(record.status, "draft_failed");
    assert.equal(record.error, "Invalid credentials");
  });

  test("draft_failed when Gmail returns nothing useful", () => {
    assert.equal(lib.buildStatusRecord(drafted, {}, NOW).status, "draft_failed");
  });

  test("keeps the classification status when no draft was needed", () => {
    assert.equal(lib.buildStatusRecord(university, university, NOW).status, "no_reply_needed");
  });

  test("log is capped at 200 entries", () => {
    const store = {};
    for (let i = 0; i < 205; i++) lib.appendLog(store, { n: i });
    assert.equal(store.log.length, 200);
    assert.equal(store.log[0].n, 5);
  });
});
