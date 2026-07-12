import { afterEach, describe, expect, it, vi } from "vitest";
import { findWiki, isProbeableBase, slugCandidates } from "../wiki";

/**
 * SV1 (docs/plans/M2-sz-voice.md): `researchTitle("Re:ZERO …")` died with
 * `Invalid URL` (2026-07-12) — the title's colon rode into a fandom hostname
 * (`https://re:zero.fandom.com`, whose colon `new URL` reads as an invalid
 * port). These lock the sanitized slug derivation, the discovery guard, the
 * override short-circuit, and candidate fall-through. HTTP is mocked (no live
 * fandom traffic): `fetch` is stubbed to a minimal MediaWiki that answers the
 * relevance probes for a chosen "winning" host and 404s the rest.
 */

type MwBody = Record<string, unknown>;

/** Every relevance probe answered affirmatively (statistics + search hit). */
function relevant(sitename: string): MwBody {
  return {
    query: {
      statistics: { articles: 800 },
      general: { sitename },
      searchinfo: { totalhits: 5 },
      search: [{ title: "match" }],
    },
  };
}

/**
 * Stub `fetch` with a MediaWiki that returns `relevant()` for whichever host
 * `answer` accepts and a 404 otherwise. Records the requested hostnames in
 * order so tests can assert which candidates were probed and in what sequence.
 */
function stubFandom(answer: (host: string, params: URLSearchParams) => MwBody | null) {
  const hosts: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    const body = answer(url.hostname, url.searchParams);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { hosts };
}

const LEGAL_SLUG = /^[a-z0-9-]+$/;

describe("slugCandidates — hostname-legal sanitization (SV1)", () => {
  const cases: [string, string][] = [
    ["Re:ZERO kara Hajimeru Isekai Seikatsu", "rezerokarahajimeruisekaiseikatsu"],
    ["Re:Zero", "rezero"],
    ["Fate/Zero", "fatezero"],
    ["Oshi no Ko", "oshinoko"],
    ["Steins;Gate", "steinsgate"],
  ];
  it.each(cases)("%s → legal slugs including %s", (title, expected) => {
    const slugs = slugCandidates(title);
    expect(slugs).toContain(expected);
    for (const s of slugs) {
      expect(s).toMatch(LEGAL_SLUG);
      // The load-bearing invariant: no colon/slash/semicolon/space escapes.
      expect(s).not.toMatch(/[:/;\s]/);
    }
  });
});

describe("isProbeableBase — the discovery guard (SV1)", () => {
  it("accepts well-formed fandom bases", () => {
    expect(isProbeableBase("https://rezero.fandom.com")).toBe(true);
    expect(isProbeableBase("https://re-zero-kara.fandom.com")).toBe(true);
  });

  it("rejects the colon-injection base that crashed research live", () => {
    expect(isProbeableBase("https://re:zero.fandom.com")).toBe(false);
  });

  it("rejects slash-injected, non-https, and non-fandom bases", () => {
    expect(isProbeableBase("https://fate/zero.fandom.com")).toBe(false);
    expect(isProbeableBase("http://rezero.fandom.com")).toBe(false);
    expect(isProbeableBase("https://evil.example.com")).toBe(false);
  });
});

describe("findWiki — SV1 URL hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the override map hit for re:zero short-circuits derivation", async () => {
    const { hosts } = stubFandom((host) =>
      host === "rezero.fandom.com" ? relevant("Re:Zero Wiki") : null,
    );
    const res = await findWiki("Re:Zero");
    expect(res?.base).toBe("https://rezero.fandom.com");
    // The override is probed FIRST — before any derived slug.
    expect(hosts[0]).toBe("rezero.fandom.com");
  });

  it("the exact 2026-07-12 crash title resolves without throwing", async () => {
    stubFandom((host) => (host === "rezero.fandom.com" ? relevant("Re:Zero Wiki") : null));
    await expect(findWiki("Re:ZERO kara Hajimeru Isekai Seikatsu")).resolves.toEqual({
      base: "https://rezero.fandom.com",
      articles: 800,
    });
  });

  it("an unmapped colon title resolves via sanitized derivation, never Invalid URL", async () => {
    const { hosts } = stubFandom((host) =>
      host === "zenithprotocol.fandom.com" ? relevant("Zenith Protocol Wiki") : null,
    );
    const res = await findWiki("Zenith:Protocol");
    expect(res?.base).toBe("https://zenithprotocol.fandom.com");
    // No colon ever reached a requested hostname — the crash root cause is gone.
    for (const h of hosts) expect(h).not.toContain(":");
  });

  it("falls through when candidate 1 misses and candidate 2 succeeds", async () => {
    // "Zenith:Protocol" derives [zenithprotocol, zenith-protocol, zenith];
    // candidate 1 404s (the reachable analog of a dead/invalid candidate),
    // candidate 2 wins — proving the discovery loop advances rather than
    // crashing or stopping.
    const { hosts } = stubFandom((host) =>
      host === "zenith-protocol.fandom.com" ? relevant("Zenith Protocol Wiki") : null,
    );
    const res = await findWiki("Zenith:Protocol");
    expect(res?.base).toBe("https://zenith-protocol.fandom.com");
    expect(hosts[0]).toBe("zenithprotocol.fandom.com");
    expect(hosts).toContain("zenith-protocol.fandom.com");
  });

  it("returns null when no candidate is relevant (existence guard, no throw)", async () => {
    stubFandom(() => null);
    await expect(findWiki("Totally Unknown Colon:Title")).resolves.toBeNull();
  });
});
