import type { Db } from "@/lib/db";
import { describe, expect, it } from "vitest";
import { classifyMetaMessage, runMeta, shouldDispatchMeta } from "../meta";

/**
 * Meta-conversation tests (Phase 5, v3-audit closure). Exercise the
 * pure classifier + the runMeta generator against a fake DB + stubbed
 * MetaDirector. Real DB + provider round-trips are acceptance-ritual
 * scope.
 */

const CAMPAIGN = "22222222-2222-4222-9222-222222222222";
const USER = "u-1";

describe("classifyMetaMessage — slash-command parsing", () => {
  it("detects /meta with a payload", () => {
    expect(classifyMetaMessage("/meta tone feels off")).toEqual({
      command: "meta",
      payload: "tone feels off",
    });
  });
  it("detects /meta with no payload", () => {
    expect(classifyMetaMessage("/meta")).toEqual({ command: "meta", payload: "" });
  });
  it("detects /resume with suffix (pipes as next turn)", () => {
    expect(classifyMetaMessage("/resume I turn to Jet")).toEqual({
      command: "resume",
      payload: "I turn to Jet",
    });
  });
  it("detects /resume with no suffix", () => {
    expect(classifyMetaMessage("/resume")).toEqual({ command: "resume", payload: "" });
  });
  it("detects /play, /back, /exit as exit variants", () => {
    expect(classifyMetaMessage("/play").command).toBe("play");
    expect(classifyMetaMessage("/back").command).toBe("back");
    expect(classifyMetaMessage("/exit").command).toBe("exit");
  });
  it("returns null command for non-prefixed messages", () => {
    expect(classifyMetaMessage("I walk to the bar")).toEqual({
      command: null,
      payload: "I walk to the bar",
    });
  });
  it("is case-insensitive on the command prefix", () => {
    expect(classifyMetaMessage("/META x").command).toBe("meta");
    expect(classifyMetaMessage("/Resume").command).toBe("resume");
  });
  it("trims leading whitespace before the slash", () => {
    expect(classifyMetaMessage("   /meta hi").command).toBe("meta");
  });
  it("does NOT match substrings (/metafoo, /playing, /resumestuff)", () => {
    // Word-boundary guard: only whitespace or end-of-string counts as the
    // command's end. Without this, `/metafoo` silently entered meta mode.
    expect(classifyMetaMessage("/metafoo").command).toBe(null);
    expect(classifyMetaMessage("/playing chess").command).toBe(null);
    expect(classifyMetaMessage("/resumestuff").command).toBe(null);
    expect(classifyMetaMessage("/exiting").command).toBe(null);
  });
});

describe("shouldDispatchMeta — routing decision", () => {
  it("dispatches meta on any slash command", () => {
    expect(shouldDispatchMeta("/meta x", undefined)).toBe(true);
    expect(shouldDispatchMeta("/resume", undefined)).toBe(true);
    expect(shouldDispatchMeta("/exit", undefined)).toBe(true);
  });
  it("dispatches meta while state is active (non-slash continuation)", () => {
    expect(shouldDispatchMeta("that's better", { active: true })).toBe(true);
  });
  it("does NOT dispatch meta on gameplay message with inactive state", () => {
    expect(shouldDispatchMeta("I draw my sword", { active: false })).toBe(false);
    expect(shouldDispatchMeta("I draw my sword", undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runMeta integration — fake DB that tracks writes + stub MetaDirector.
// ---------------------------------------------------------------------------

interface FakeDbState {
  settings: Record<string, unknown>;
  updateCalls: Array<{ patch: unknown }>;
}

function fakeDb(state: FakeDbState): Db {
  return {
    select: (_cols?: unknown) => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          limit: async () => [
            {
              id: CAMPAIGN,
              userId: USER,
              settings: state.settings,
              deletedAt: null,
              name: "test",
            },
          ],
          orderBy: (_o: unknown) => ({
            limit: async () => [], // no prior turns
          }),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (patch: unknown) => {
        state.updateCalls.push({ patch });
        return {
          where: async () => ({ rowCount: 1 }),
        };
      },
    }),
  } as unknown as Db;
}

const stubMetaDirector = (async () => ({
  response: "Noted — I'll lean into restraint next scene.",
  suggested_override: null,
})) as unknown as Parameters<typeof runMeta>[1]["runMetaDirectorFn"];

describe("runMeta — /meta entry path", () => {
  it("emits 'entered' then 'text' on a fresh /meta message", async () => {
    const dbState: FakeDbState = { settings: {}, updateCalls: [] };
    const db = fakeDb(dbState);

    const events: string[] = [];
    const texts: string[] = [];
    for await (const ev of runMeta(
      { campaignId: CAMPAIGN, userId: USER, playerMessage: "/meta less ornate prose" },
      { db, runMetaDirectorFn: stubMetaDirector },
    )) {
      events.push(ev.type);
      if (ev.type === "text") texts.push(ev.delta);
    }
    expect(events).toContain("entered");
    expect(events).toContain("text");
    expect(texts.join(" ")).toMatch(/noted/i);

    // Meta state persisted.
    expect(dbState.updateCalls).toHaveLength(1);
    const patch = dbState.updateCalls[0]?.patch as { settings: Record<string, unknown> };
    const meta = patch.settings.meta_conversation as {
      active: boolean;
      history: Array<{ role: string; text: string }>;
    };
    expect(meta.active).toBe(true);
    expect(meta.history).toHaveLength(2); // player + director
    expect(meta.history[0]?.role).toBe("player");
    expect(meta.history[1]?.role).toBe("director");
  });

  it("appends to existing history when meta is already active", async () => {
    const dbState: FakeDbState = {
      settings: {
        meta_conversation: {
          active: true,
          started_at_turn: 5,
          history: [
            { role: "player", text: "tone feels off", ts: "2026-04-21T00:00:00Z" },
            {
              role: "director",
              text: "Got it — what specifically?",
              ts: "2026-04-21T00:00:01Z",
            },
          ],
        },
      },
      updateCalls: [],
    };
    const db = fakeDb(dbState);

    for await (const _ of runMeta(
      { campaignId: CAMPAIGN, userId: USER, playerMessage: "too much dwelling" },
      { db, runMetaDirectorFn: stubMetaDirector },
    )) {
      /* drain */
    }

    const patch = dbState.updateCalls[0]?.patch as { settings: Record<string, unknown> };
    const meta = patch.settings.meta_conversation as {
      history: Array<{ role: string }>;
    };
    expect(meta.history).toHaveLength(4); // prior 2 + new player + new director
  });
});

describe("runMeta — /resume exits cleanly", () => {
  it("clears meta_conversation and emits exited with no suffix", async () => {
    const dbState: FakeDbState = {
      settings: {
        meta_conversation: {
          active: true,
          started_at_turn: 5,
          history: [],
        },
      },
      updateCalls: [],
    };
    const db = fakeDb(dbState);

    const events: Array<{ type: string; pendingResumeSuffix?: string }> = [];
    for await (const ev of runMeta(
      { campaignId: CAMPAIGN, userId: USER, playerMessage: "/resume" },
      { db, runMetaDirectorFn: stubMetaDirector },
    )) {
      events.push(ev as { type: string; pendingResumeSuffix?: string });
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("exited");
    expect(events[0]?.pendingResumeSuffix).toBeUndefined();

    // State cleared: meta_conversation dropped from settings.
    const patch = dbState.updateCalls[0]?.patch as { settings: Record<string, unknown> };
    expect(patch.settings.meta_conversation).toBeUndefined();
  });

  it("emits exited with pendingResumeSuffix when /resume has a payload", async () => {
    const dbState: FakeDbState = {
      settings: {
        meta_conversation: { active: true, started_at_turn: 5, history: [] },
      },
      updateCalls: [],
    };
    const db = fakeDb(dbState);

    const events: Array<{ type: string; pendingResumeSuffix?: string }> = [];
    for await (const ev of runMeta(
      {
        campaignId: CAMPAIGN,
        userId: USER,
        playerMessage: "/resume I turn to Jet",
      },
      { db, runMetaDirectorFn: stubMetaDirector },
    )) {
      events.push(ev as { type: string; pendingResumeSuffix?: string });
    }
    expect(events[0]?.pendingResumeSuffix).toBe("I turn to Jet");
  });
});

describe("runMeta — /play, /back, /exit all exit without piping", () => {
  for (const cmd of ["/play", "/back", "/exit"] as const) {
    it(`clears state on ${cmd}`, async () => {
      const dbState: FakeDbState = {
        settings: {
          meta_conversation: { active: true, started_at_turn: 5, history: [] },
        },
        updateCalls: [],
      };
      const db = fakeDb(dbState);

      let exitedEvent: { type: string; pendingResumeSuffix?: string } | undefined;
      for await (const ev of runMeta(
        { campaignId: CAMPAIGN, userId: USER, playerMessage: cmd },
        { db, runMetaDirectorFn: stubMetaDirector },
      )) {
        if (ev.type === "exited")
          exitedEvent = ev as { type: string; pendingResumeSuffix?: string };
      }
      expect(exitedEvent?.type).toBe("exited");
      expect(exitedEvent?.pendingResumeSuffix).toBeUndefined();
      const patch = dbState.updateCalls[0]?.patch as { settings: Record<string, unknown> };
      expect(patch.settings.meta_conversation).toBeUndefined();
    });
  }
});

describe("runMeta — suggested_override surfaces when director proposes one", () => {
  it("emits suggested_override event with category + value", async () => {
    const dbState: FakeDbState = { settings: {}, updateCalls: [] };
    const db = fakeDb(dbState);
    const directorWithOverride = (async () => ({
      response: "Got it — I'll lock that in.",
      suggested_override: {
        category: "CONTENT_CONSTRAINT" as const,
        value: "No explicit violence in narration",
      },
    })) as unknown as Parameters<typeof runMeta>[1]["runMetaDirectorFn"];

    const events: Array<{ type: string; category?: string; value?: string }> = [];
    for await (const ev of runMeta(
      {
        campaignId: CAMPAIGN,
        userId: USER,
        playerMessage: "/meta no graphic violence please",
      },
      { db, runMetaDirectorFn: directorWithOverride },
    )) {
      events.push(ev as never);
    }
    const suggested = events.find((e) => e.type === "suggested_override");
    expect(suggested).toBeDefined();
    expect(suggested?.category).toBe("CONTENT_CONSTRAINT");
    expect(suggested?.value).toBe("No explicit violence in narration");
  });
});
