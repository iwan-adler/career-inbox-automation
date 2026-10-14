// Checks the generated n8n workflow: structure, no secrets, in sync with the source,
// and runs the Code nodes' JavaScript in a small fake of the n8n Code-node environment.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildWorkflow, OUT_PATH } = require("../scripts/build-workflow.js");
const samples = require("../examples/sample-emails.json");

const workflow = buildWorkflow();
const node = (name) => workflow.nodes.find((n) => n.name === name);

describe("workflow structure", () => {
  test("node names and ids are unique", () => {
    assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
    assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
  });

  test("every connection points at an existing node", () => {
    for (const [from, { main }] of Object.entries(workflow.connections)) {
      assert.ok(node(from), `unknown source ${from}`);
      for (const output of main) for (const link of output) assert.ok(node(link.node), `unknown target ${link.node}`);
    }
  });

  test("contains no credentials and never sends email", () => {
    const json = JSON.stringify(workflow);
    assert.ok(!json.includes('"credentials"'), "credentials must be configured in n8n, not exported");
    for (const n of workflow.nodes.filter((n) => n.type === "n8n-nodes-base.gmail")) {
      assert.equal(n.parameters.resource, "draft", `${n.name} must only create drafts`);
      assert.notEqual(n.parameters.operation, "send");
    }
  });

  test("draft failures are routed, not fatal", () => {
    assert.equal(node("Create Gmail draft").onError, "continueErrorOutput");
    assert.equal(workflow.connections["Create Gmail draft"].main.length, 2);
  });

  test("generated code uses LF line endings on every OS", () => {
    for (const n of workflow.nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
      assert.ok(!n.parameters.jsCode.includes(String.fromCharCode(13)), `${n.name} contains CR characters`);
    }
  });

  test("committed workflow file is up to date (run: node scripts/build-workflow.js)", () => {
    const committed = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(workflow)));
  });
});

describe("Code nodes run in a simulated n8n environment", () => {
  const classifyCode = node("Classify & extract").parameters.jsCode;
  const recordCode = node("Record status").parameters.jsCode;

  test("code contains no Node-only constructs", () => {
    for (const code of [classifyCode, recordCode]) {
      assert.ok(!/\brequire\(|module\.exports/.test(code));
    }
  });

  function runClassify(items, store) {
    const fn = new Function("$input", "$getWorkflowStaticData", classifyCode);
    return fn({ all: () => items.map((json) => ({ json })) }, () => store);
  }

  function runRecord(input, original, store) {
    const fn = new Function("$json", "$", "$getWorkflowStaticData", recordCode);
    const $ = (name) => {
      assert.equal(name, "Classify & extract");
      return { item: { json: original } };
    };
    return fn(input, $, () => store);
  }

  test("classify -> draft -> record, with persistent static data", () => {
    const store = {};
    const classified = runClassify(samples, store);

    assert.equal(classified.length, samples.length);
    assert.deepEqual(
      classified.map((i) => i.json.category),
      samples.map((s) => s._expected.category),
    );
    assert.equal(store.processedIds.length, samples.length);

    // Simulate the IF node and the Gmail node.
    for (const { json } of classified) {
      const gmailOutput = json.action === "draft" ? { id: `draft-${json.id}` } : json;
      const record = runRecord(gmailOutput, json, store).json;
      assert.equal(record.status, json.action === "draft" ? "drafted" : json.status);
    }
    assert.equal(store.log.length, samples.length);

    // A second run over the same emails creates nothing new.
    const again = runClassify(samples, store);
    assert.ok(again.every((i) => i.json.status === "duplicate" && i.json.action === "none"));
  });

  test("Gmail error is recorded as draft_failed", () => {
    const store = {};
    const [first] = runClassify([samples[0]], store);
    const record = runRecord({ error: "Request failed with status code 401" }, first.json, store).json;
    assert.equal(record.status, "draft_failed");
    assert.match(record.error, /401/);
  });

  test("the IF condition matches what the Code node emits", () => {
    const condition = node("Needs a draft?").parameters.conditions.conditions[0];
    assert.equal(condition.leftValue, "={{ $json.action }}");
    const [first] = runClassify([samples[0]], {});
    assert.equal(first.json.action, condition.rightValue);
  });

  test("the draft node's expressions reference fields the Code node emits", () => {
    const [first] = runClassify([samples[0]], {});
    const { reply, threadId, from } = first.json;
    assert.ok(reply.subject && reply.body && threadId && from.address);
  });
});
