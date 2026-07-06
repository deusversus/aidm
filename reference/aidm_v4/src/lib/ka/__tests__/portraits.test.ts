import { describe, expect, it } from "vitest";
import { buildPortraitMap, extractNames, stubPortraitResolver } from "../portraits";

describe("extractNames", () => {
  it("extracts single-word bolded names", () => {
    const narrative = "The door opened. **Faye** stepped in, a cigarette already lit.";
    expect(extractNames(narrative)).toEqual(["Faye"]);
  });

  it("extracts multi-word names", () => {
    const narrative =
      "**Jet Black** looked up from his bonsai. **Spike Spiegel** was already at the console.";
    expect(extractNames(narrative)).toEqual(["Jet Black", "Spike Spiegel"]);
  });

  it("preserves first-mention order", () => {
    const narrative =
      "**Vicious** smiled. **Julia** did not. **Vicious** turned back to the window.";
    expect(extractNames(narrative)).toEqual(["Vicious", "Julia"]);
  });

  it("handles hyphens and apostrophes in names", () => {
    const narrative = "**O'Brien** laughed. **Jean-Luc** did not.";
    expect(extractNames(narrative)).toEqual(["O'Brien", "Jean-Luc"]);
  });

  it("skips ALL-CAPS tokens (onomatopoeia)", () => {
    const narrative = "**BANG**. The door swung open. **Faye** was already there.";
    expect(extractNames(narrative)).toEqual(["Faye"]);
  });

  it("skips single-letter bolds", () => {
    const narrative = "**X** marks the spot, **Spike** thought.";
    expect(extractNames(narrative)).toEqual(["Spike"]);
  });

  it("returns empty array when no bolds exist", () => {
    expect(extractNames("A quiet, empty narration with no names.")).toEqual([]);
  });

  it("is case-sensitive to the leading capital", () => {
    const narrative = "**faye** doesn't count. **Faye** does.";
    expect(extractNames(narrative)).toEqual(["Faye"]);
  });
});

describe("buildPortraitMap", () => {
  it("calls the resolver once per distinct name", async () => {
    const seen: string[] = [];
    const resolver = async (name: string) => {
      seen.push(name);
      return `/portraits/${name.toLowerCase().replace(/\s+/g, "-")}.png`;
    };
    const map = await buildPortraitMap(
      "**Spike** walked past **Faye**. **Spike** didn't look.",
      resolver,
    );
    expect(seen).toEqual(["Spike", "Faye"]);
    expect(map).toEqual({
      Spike: "/portraits/spike.png",
      Faye: "/portraits/faye.png",
    });
  });

  it("default stub resolver returns null URLs — names still present", async () => {
    const map = await buildPortraitMap("**Jet** adjusted the bonsai.", stubPortraitResolver);
    expect(map).toEqual({ Jet: null });
  });

  it("empty narrative → empty map", async () => {
    const map = await buildPortraitMap("", stubPortraitResolver);
    expect(map).toEqual({});
  });
});
