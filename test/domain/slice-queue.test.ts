import { test } from "node:test";
import assert from "node:assert/strict";

import { SliceQueue } from "../../src/domain/slice/slice-queue.js";

// ---------------------------------------------------------------------------
// parse / serialize round-trip
// ---------------------------------------------------------------------------

const SAMPLE_QUEUE_MD = `# Slice Queue

## S-01: Auth module
status: pending
deps: none
requeue_count: 0
phase_dir: phases/phase-01
source: design
acceptance_criteria:
  - Login works
  - Logout works

## S-02: Dashboard
status: ready
deps: S-01
requeue_count: 1
last_reason: Missing data
phase_dir: phases/phase-02
source: design
acceptance_criteria:
  - Dashboard loads
`;

test("SliceQueue.parse produces correct slices", () => {
  const q = SliceQueue.parse(SAMPLE_QUEUE_MD);
  assert.equal(q.length, 2);

  const s01 = q.getById("S-01");
  assert.ok(s01);
  assert.equal(s01.title, "Auth module");
  assert.equal(s01.status, "pending");
  assert.deepEqual(s01.deps, []);
  assert.equal(s01.requeueCount, 0);
  assert.deepEqual(s01.acceptanceCriteria, ["Login works", "Logout works"]);
  assert.equal(s01.phaseDir, "phases/phase-01");
  assert.equal(s01.source, "design");

  const s02 = q.getById("S-02");
  assert.ok(s02);
  assert.equal(s02.status, "ready");
  assert.deepEqual(s02.deps, ["S-01"]);
  assert.equal(s02.requeueCount, 1);
  assert.equal(s02.lastReason, "Missing data");
});

test("SliceQueue.serialize round-trips cleanly", () => {
  const q = SliceQueue.parse(SAMPLE_QUEUE_MD);
  const serialized = q.serialize();
  const q2 = SliceQueue.parse(serialized);
  assert.equal(q2.length, 2);
  assert.equal(q2.getById("S-01")?.status, "pending");
  assert.equal(q2.getById("S-02")?.status, "ready");
  assert.equal(q2.getById("S-02")?.lastReason, "Missing data");
});

test("SliceQueue.empty().serialize() returns empty marker", () => {
  const s = SliceQueue.empty().serialize();
  assert.match(s, /empty/);
});

// ---------------------------------------------------------------------------
// selectNextReady
// ---------------------------------------------------------------------------

test("selectNextReady promotes pending slice with satisfied deps", () => {
  const md = `# Slice Queue

## S-01: First
status: done
deps: none
requeue_count: 0
phase_dir: phases/phase-01
source: design
acceptance_criteria:
  - done

## S-02: Second
status: pending
deps: S-01
requeue_count: 0
phase_dir: phases/phase-02
source: design
acceptance_criteria:
  - ok
`;
  const q = SliceQueue.parse(md);
  const next = q.selectNextReady();
  assert.ok(next);
  assert.equal(next.id, "S-02");
});

test("selectNextReady returns undefined when all slices done", () => {
  const md = `# Slice Queue

## S-01: First
status: done
deps: none
requeue_count: 0
phase_dir: phases/phase-01
source: design
acceptance_criteria:
  - ok
`;
  const q = SliceQueue.parse(md);
  assert.equal(q.selectNextReady(), undefined);
});

test("isExhausted is true when all slices done or blocked", () => {
  const md = `# Slice Queue

## S-01: Done
status: done
deps: none
requeue_count: 0
phase_dir: phases/phase-01
source: design
acceptance_criteria:
  - ok

## S-02: Blocked
status: blocked
deps: none
requeue_count: 3
phase_dir: phases/phase-02
source: design
acceptance_criteria:
  - ok
`;
  const q = SliceQueue.parse(md);
  assert.equal(q.isExhausted(), true);
});

// ---------------------------------------------------------------------------
// Status mutations
// ---------------------------------------------------------------------------

test("markBuilding, markDone, requeue, escalate mutate correctly", () => {
  const md = `# Slice Queue

## S-01: Test
status: ready
deps: none
requeue_count: 0
phase_dir: phases/phase-01
source: design
acceptance_criteria:
  - ok
`;
  let q = SliceQueue.parse(md);
  q = q.markBuilding("S-01");
  assert.equal(q.getById("S-01")?.status, "building");

  q = q.markDone("S-01");
  assert.equal(q.getById("S-01")?.status, "done");

  q = q.requeue("S-01", "test reason");
  const s = q.getById("S-01");
  assert.equal(s?.status, "ready");
  assert.equal(s?.requeueCount, 1);
  assert.equal(s?.lastReason, "test reason");

  q = q.escalate("S-01", "escalated");
  assert.equal(q.getById("S-01")?.status, "escalated");
});

// ---------------------------------------------------------------------------
// addRemediationSlices
// ---------------------------------------------------------------------------

test("addRemediationSlices appends new slices with correct defaults", () => {
  const md = `# Slice Queue

## S-01: Original
status: done
deps: none
requeue_count: 0
phase_dir: phases/phase-01
source: design
acceptance_criteria:
  - ok
`;
  const q = SliceQueue.parse(md);
  const q2 = q.addRemediationSlices([{ id: "R-001", title: "Fix login", acceptanceCriteria: ["Login fixed"] }]);
  assert.equal(q2.length, 2);
  const r = q2.getById("R-001");
  assert.ok(r);
  assert.equal(r.source, "remediation");
  assert.equal(r.status, "ready");
  assert.equal(r.phaseDir, "phases/phase-02");
  assert.deepEqual(r.deps, []);
});

test("addRemediationSlicesFromMarkdown parses reflector block", () => {
  const block = `
### R-001: Fix login
acceptance_criteria:
  - Login returns 200

### R-002: Fix logout
acceptance_criteria:
  - Logout clears session
`;
  const q = SliceQueue.empty().addRemediationSlicesFromMarkdown(block);
  assert.equal(q.length, 2);
  assert.equal(q.getById("R-001")?.title, "Fix login");
  assert.deepEqual(q.getById("R-002")?.acceptanceCriteria, ["Logout clears session"]);
});

// ---------------------------------------------------------------------------
// buildInitial
// ---------------------------------------------------------------------------

test("buildInitial parses Vertical Slices section from design.md", () => {
  const designMd = `# Design

## Overview
Some overview text.

## Vertical Slices

### S-01: Authentication
deps: none
acceptance_criteria:
  - Login works

### S-02: Dashboard
deps: S-01
acceptance_criteria:
  - Shows data

## Other Section
Irrelevant.
`;
  const q = SliceQueue.buildInitial(designMd);
  assert.equal(q.length, 2);
  const s01 = q.getById("S-01");
  assert.ok(s01);
  assert.equal(s01.status, "pending");
  assert.deepEqual(s01.deps, []);
  const s02 = q.getById("S-02");
  assert.ok(s02);
  assert.deepEqual(s02.deps, ["S-01"]);
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

test("reconcile preserves done slices and adds new slices from new design", () => {
  const oldDesign = `# Design

## Vertical Slices

### S-01: Auth
deps: none
acceptance_criteria:
  - ok

### S-02: Dashboard
deps: S-01
acceptance_criteria:
  - ok
`;
  let q = SliceQueue.buildInitial(oldDesign);
  q = q.requeue("S-01", "").markDone("S-01");

  const newDesign = `# Design

## Vertical Slices

### S-01: Auth
deps: none
acceptance_criteria:
  - ok (unchanged)

### S-03: Reports
deps: S-01
acceptance_criteria:
  - Reports load
`;
  const reconciled = q.reconcile(newDesign, { preserveDone: true });

  const ids = reconciled.slices.map((s) => s.id);
  assert.ok(ids.includes("S-01"), "S-01 (done) preserved");
  assert.ok(ids.includes("S-03"), "S-03 (new) added");
  assert.ok(!ids.includes("S-02"), "S-02 (not done, not in new design) dropped");
  assert.equal(reconciled.getById("S-01")?.status, "done");
});
