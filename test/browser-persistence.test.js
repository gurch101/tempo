import { describe, expect, it } from "vitest";
import { createSectionSaveQueue, loadConsistentSections } from "../public/browser-persistence.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function queueHarness(send, overrides = {}) {
  let revision = 0, offline = false;
  const confirmed = [], saved = [], errors = [];
  const queue = createSectionSaveQueue({
    send, getRevision: () => revision, setRevision: value => { revision = value; },
    isOffline: () => offline, setOffline: value => { offline = value; },
    recoverConflict: overrides.recoverConflict || (async () => {}),
    onConfirmed: value => confirmed.push(value), onSaved: value => saved.push(value), onError: error => errors.push(error)
  });
  return { queue, confirmed, saved, errors, get revision() { return revision; }, get offline() { return offline; } };
}

describe("browser persistence orchestration", () => {
  it("retries mixed-revision section reads until one consistent snapshot is available", async () => {
    let calls = 0;
    const result = await loadConsistentSections(async () => ++calls === 1
      ? [{ revision: 4, data: "old" }, { revision: 5, data: "new" }]
      : [{ revision: 5, data: "current-a" }, { revision: 5, data: "current-b" }]);
    expect(calls).toBe(2);
    expect(result).toEqual({ revision: 5, payloads: [{ revision: 5, data: "current-a" }, { revision: 5, data: "current-b" }] });
  });

  it("fails closed when a consistent startup snapshot cannot be obtained", async () => {
    let revision = 0;
    await expect(loadConsistentSections(async () => [{ revision: revision++, data: 1 }, { revision: revision++, data: 2 }], 3))
      .rejects.toMatchObject({ code: "inconsistent_snapshot" });
  });

  it("coalesces overlapping saves while sending only the requested sections", async () => {
    const gate = deferred(), sent = [];
    const harness = queueHarness(async (section, body, revision) => {
      sent.push({ section, body: structuredClone(body), revision });
      if (section === "timers") await gate.promise;
      return { data: body, revision: revision + 1 };
    });
    const state = { timers: [{ id: 1 }], widgets: [{ id: 2 }], logs: {}, foods: [], meals: [], foodLogs: {}, nutritionGoal: null, strength: {} };
    const first = harness.queue.save(state, "timers");
    await Promise.resolve();
    state.widgets[0].name = "Water";
    const second = harness.queue.save(state, "habits");
    gate.resolve();
    await Promise.all([first, second]);
    expect(sent).toEqual([
      { section: "timers", body: [{ id: 1 }], revision: 0 },
      { section: "habits", body: [{ id: 2, name: "Water" }], revision: 1 }
    ]);
    expect(harness.saved).toEqual([2]);
    expect(harness.errors).toEqual([]);
  });

  it("reconciles generated ids into dependent sections queued during a save", async () => {
    const gate = deferred(), sent = [];
    const harness = queueHarness(async (section, body, revision) => {
      sent.push({ section, body: structuredClone(body) });
      if (section === "foods") { await gate.promise; return { data: [{ ...body[0], id: 42 }], revision: revision + 1 }; }
      return { data: [{ ...body[0], id: 84 }], revision: revision + 1 };
    });
    const state = { timers: [], widgets: [], logs: {}, foods: [{ id: "food-temp", title: "Oats" }], meals: [], foodLogs: {}, nutritionGoal: null, strength: {} };
    const first = harness.queue.save(state, "foods");
    await Promise.resolve();
    state.meals.push({ id: "meal-temp", title: "Breakfast", items: [{ foodId: "food-temp", servingSize: 40 }] });
    const second = harness.queue.save(state, "meals");
    gate.resolve();
    await Promise.all([first, second]);
    expect(sent[1]).toMatchObject({ section: "meals", body: [{ items: [{ foodId: 42 }] }] });
    expect(harness.confirmed.at(-1)).toMatchObject({ foods: [{ id: 42 }], meals: [{ id: 84, items: [{ foodId: 42 }] }] });
  });

  it("recovers a revision conflict and reports the save as unsuccessful", async () => {
    let recovered = 0;
    const conflict = Object.assign(new Error("conflict"), { status: 412 });
    const harness = queueHarness(async () => { throw conflict; }, { recoverConflict: async () => { recovered += 1; } });
    const state = { timers: [], widgets: [], logs: {}, foods: [], meals: [], foodLogs: {}, nutritionGoal: null, strength: {} };
    await expect(harness.queue.save(state, "timers")).resolves.toBe(false);
    expect(recovered).toBe(1);
    expect(harness.errors).toEqual([conflict]);
  });
});
