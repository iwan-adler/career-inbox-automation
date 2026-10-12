// Builds workflow/career-inbox-workflow.json (importable into n8n) from src/career-inbox.js.
// Usage: node scripts/build-workflow.js
//
// The Code nodes get the library code verbatim plus a few lines of n8n glue, so the
// workflow always runs exactly the logic covered by the unit tests.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LIB_PATH = path.join(ROOT, "src", "career-inbox.js");
const OUT_PATH = path.join(ROOT, "workflow", "career-inbox-workflow.json");
const MARKER = "// ---- n8n:exclude-below ----";

// Gmail search used by the trigger. Edit in n8n after import if you like.
const GMAIL_QUERY = "in:inbox -category:promotions -category:social -from:me";

function libraryCode() {
  const source = fs.readFileSync(LIB_PATH, "utf8");
  const cut = source.indexOf(MARKER);
  if (cut === -1) throw new Error(`Marker "${MARKER}" not found in ${LIB_PATH}`);
  return source.slice(0, cut).trimEnd();
}

const CLASSIFY_GLUE = `
// ---- n8n glue: runs once for all items -------------------------------------
// Workflow static data persists between *production* runs (workflow active),
// not between manual test runs.
const store = $getWorkflowStaticData("global");
const emails = $input.all().map((item) => item.json);
return processEmails(emails, store, new Date()).map((json) => ({ json }));
`;

const RECORD_GLUE = `
// ---- n8n glue: runs once for each item --------------------------------------
// Input is either the Gmail draft result, a Gmail error, or the email itself
// (when no draft was needed). The original analysis comes from "Classify & extract".
const store = $getWorkflowStaticData("global");
const email = $("Classify & extract").item.json;
const record = buildStatusRecord(email, $json, new Date());
appendLog(store, record);
return { json: record };
`;

const SETUP_NOTE = `## Career Inbox Automation

**Setup (once):**
1. Open **Gmail Trigger** and **Create Gmail draft** and pick your Gmail credential.
2. Click **Test workflow** to try it on recent mail.
3. Activate the workflow to poll every 5 minutes.

**Safety:** this workflow only creates *drafts*. Nothing is sent. Review every draft in Gmail, fill in the [placeholders] and send it yourself.

**Status log:** every email ends in **Record status** with \`status\` = drafted | draft_failed | no_reply_needed | no_reply_address | thread_already_drafted | irrelevant | duplicate | invalid.

Code source & tests: see the GitHub repo (src/career-inbox.js).`;

function buildWorkflow() {
  const lib = libraryCode();
  return {
    name: "Career Inbox Automation",
    nodes: [
      {
        id: "5b0b6a0e-0001-4a4e-9a51-c0ffee000001",
        name: "Setup notes",
        type: "n8n-nodes-base.stickyNote",
        typeVersion: 1,
        position: [-80, -360],
        parameters: { content: SETUP_NOTE, height: 320, width: 520 },
      },
      {
        id: "5b0b6a0e-0001-4a4e-9a51-c0ffee000002",
        name: "Gmail Trigger",
        type: "n8n-nodes-base.gmailTrigger",
        typeVersion: 1.2,
        position: [0, 0],
        parameters: {
          pollTimes: { item: [{ mode: "everyX", value: 5, unit: "minutes" }] },
          simple: false,
          filters: { q: GMAIL_QUERY },
          options: {},
        },
      },
      {
        id: "5b0b6a0e-0001-4a4e-9a51-c0ffee000003",
        name: "Classify & extract",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [240, 0],
        parameters: { mode: "runOnceForAllItems", jsCode: `${lib}\n${CLASSIFY_GLUE}` },
      },
      {
        id: "5b0b6a0e-0001-4a4e-9a51-c0ffee000004",
        name: "Needs a draft?",
        type: "n8n-nodes-base.if",
        typeVersion: 2,
        position: [480, 0],
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
            conditions: [
              {
                id: "5b0b6a0e-0001-4a4e-9a51-c0ffee0000c1",
                leftValue: "={{ $json.action }}",
                rightValue: "draft",
                operator: { type: "string", operation: "equals" },
              },
            ],
            combinator: "and",
          },
          options: {},
        },
      },
      {
        id: "5b0b6a0e-0001-4a4e-9a51-c0ffee000005",
        name: "Create Gmail draft",
        type: "n8n-nodes-base.gmail",
        typeVersion: 2.1,
        position: [720, -120],
        onError: "continueErrorOutput",
        parameters: {
          resource: "draft",
          subject: "={{ $json.reply.subject }}",
          message: "={{ $json.reply.body }}",
          options: {
            threadId: "={{ $json.threadId }}",
            sendTo: "={{ $json.from.address }}",
          },
        },
      },
      {
        id: "5b0b6a0e-0001-4a4e-9a51-c0ffee000006",
        name: "Record status",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [980, 0],
        parameters: { mode: "runOnceForEachItem", jsCode: `${lib}\n${RECORD_GLUE}` },
      },
    ],
    connections: {
      "Gmail Trigger": { main: [[{ node: "Classify & extract", type: "main", index: 0 }]] },
      "Classify & extract": { main: [[{ node: "Needs a draft?", type: "main", index: 0 }]] },
      "Needs a draft?": {
        main: [
          [{ node: "Create Gmail draft", type: "main", index: 0 }], // true
          [{ node: "Record status", type: "main", index: 0 }], // false
        ],
      },
      "Create Gmail draft": {
        main: [
          [{ node: "Record status", type: "main", index: 0 }], // success
          [{ node: "Record status", type: "main", index: 0 }], // error output
        ],
      },
    },
    settings: { executionOrder: "v1" },
    active: false,
  };
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(buildWorkflow(), null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
}

module.exports = { buildWorkflow, OUT_PATH };
