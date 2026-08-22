import { reconcileIds, sectionOrder, sectionValue } from "./state-sections.js?v=1";

export async function loadConsistentSections(loadOnce, attempts = 3) {
  let revisions = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const payloads = await loadOnce();
    revisions = payloads.map(payload => {
      const revision = Number(payload.revision);
      return Number.isInteger(revision) && revision >= 0 ? revision : Number.NaN;
    });
    if (revisions.length && revisions.every(revision => revision === revisions[0])) {
      return { payloads, revision: revisions[0] };
    }
  }
  const error = new Error("Tempo changed while it was loading. Try again.");
  error.code = "inconsistent_snapshot";
  error.revisions = revisions;
  throw error;
}

export function createSectionSaveQueue({ send, getRevision, setRevision, isOffline, setOffline, recoverConflict, onConfirmed, onSaved, onError }) {
  const pending = new Map();
  let active = null;

  const drain = async () => {
    const confirmed = {};
    try {
      while (pending.size) {
        const batch = new Map(pending); pending.clear();
        for (const section of sectionOrder.filter(item => batch.has(item))) {
          const body = batch.get(section);
          const payload = await send(section, body, getRevision());
          setRevision(Number(payload.revision) || getRevision());
          for (const [queuedSection, value] of batch) batch.set(queuedSection, reconcileIds(value, body, payload.data));
          for (const [queuedSection, value] of pending) pending.set(queuedSection, reconcileIds(value, body, payload.data));
          confirmed[section] = payload.data;
        }
        setOffline(false);
      }
      active = null;
      if (Object.keys(confirmed).length) onConfirmed(confirmed);
      onSaved(getRevision());
      return true;
    } catch (error) {
      let failure = error;
      pending.clear();
      setOffline(true);
      if (error.status === 412) {
        try { await recoverConflict(); }
        catch (recoveryError) { failure = recoveryError; setOffline(true); }
      }
      active = null;
      onError(failure);
      return false;
    }
  };

  return {
    save(state, sections) {
      if (isOffline()) {
        onError(new Error("Tempo is offline. Reload after reconnecting before making more changes."));
        return Promise.resolve(false);
      }
      for (const section of Array.isArray(sections) ? sections : [sections]) {
        if (sectionOrder.includes(section)) pending.set(section, structuredClone(sectionValue(state, section)));
      }
      active ||= drain();
      return active;
    }
  };
}
