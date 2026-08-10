import test from "node:test";
import assert from "node:assert/strict";
import { planDocEdit } from "../shared/edit-routing.js";

test("routes a flat Calendar insert through public v1", () => {
  assert.deepEqual(
    planDocEdit([
      {
        op: "insert",
        under: "today",
        items: [{ n: "Prepare release post", d: "Use the final screenshots", l: "todo" }],
        position: "bottom",
      },
    ]),
    {
      backend: "public_v1",
      operation: "insert",
      path: "/nodes",
      method: "POST",
      body: {
        parent_id: "today",
        name: "Prepare release post",
        note: "Use the final screenshots",
        layoutMode: "todo",
        position: "bottom",
      },
    },
  );
});

test("maps LLM code and quote line types to public API layouts", () => {
  const codePlan = planDocEdit([
    { op: "insert", under: "inbox", items: [{ n: "const x = 1", l: "code" }] },
  ]);
  assert.equal(codePlan.backend, "public_v1");
  if (codePlan.backend === "public_v1") {
    assert.deepEqual(codePlan.body, {
      parent_id: "inbox",
      name: "const x = 1",
      layoutMode: "code-block",
      position: "top",
    });
  }

  const quotePlan = planDocEdit([
    { op: "update", ref: "aa11bb22cc33", to: { l: "quote" } },
  ]);
  assert.equal(quotePlan.backend, "public_v1");
  if (quotePlan.backend === "public_v1") {
    assert.deepEqual(quotePlan.body, { layoutMode: "quote-block" });
  }
});

test("routes ordinary update, completion, deletion, and move through public v1", () => {
  assert.deepEqual(
    planDocEdit([{ op: "update", ref: "aa11bb22cc33", to: { n: "Renamed", d: "New note" } }]),
    {
      backend: "public_v1",
      operation: "update",
      path: "/nodes/aa11bb22cc33",
      method: "POST",
      body: { name: "Renamed", note: "New note" },
    },
  );
  assert.deepEqual(
    planDocEdit([{ op: "update", ref: "aa11bb22cc33", to: { x: 1 } }]),
    {
      backend: "public_v1",
      operation: "complete",
      path: "/nodes/aa11bb22cc33/complete",
      method: "POST",
    },
  );
  assert.deepEqual(
    planDocEdit([{ op: "delete", ref: "aa11bb22cc33" }]),
    {
      backend: "public_v1",
      operation: "delete",
      path: "/nodes/aa11bb22cc33",
      method: "DELETE",
    },
  );
  assert.deepEqual(
    planDocEdit([
      { op: "move", ref: "aa11bb22cc33", under: "tomorrow", position: "bottom" },
    ]),
    {
      backend: "public_v1",
      operation: "move",
      path: "/nodes/aa11bb22cc33/move",
      method: "POST",
      body: { parent_id: "tomorrow", position: "bottom" },
    },
  );
});

test("keeps richer and grouped edits on the LLM document API", () => {
  const cases = [
    [
      {
        op: "insert" as const,
        under: "inbox",
        items: [{ n: "Project", c: [{ n: "Task" }] }],
      },
    ],
    [
      {
        op: "insert" as const,
        after: "aa11bb22cc33",
        items: [{ n: "Next sibling" }],
      },
    ],
    [
      {
        op: "insert" as const,
        under: "inbox",
        items: [{ n: "Table", l: "table" }],
      },
    ],
    [
      {
        op: "update" as const,
        ref: "aa11bb22cc33",
        to: { n: "Done", x: 1 },
      },
    ],
    [
      { op: "update" as const, ref: "aa11bb22cc33", to: { x: 1 } },
      { op: "delete" as const, ref: "dd44ee55ff66" },
    ],
  ];

  for (const operations of cases) {
    assert.equal(planDocEdit(operations).backend, "llm_doc");
  }
});
