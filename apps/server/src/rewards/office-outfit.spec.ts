import { describe, expect, it } from "vitest";
import { SHOP_ITEMS, SHOP_SLOTS } from "@nexura/shared";
import { NEXURA_OUTFIT } from "../../../../third_party/agent-office/src/shared/nexura-outfit.ts";

describe("the 3D office's copy of the shop's cosmetics", () => {
  it("lists every cosmetic of the catalog, in its slot, and nothing else", () => {
    for (const slot of SHOP_SLOTS) {
      expect([...NEXURA_OUTFIT[slot]].sort()).toEqual(SHOP_ITEMS.filter((item) => item.kind === slot).map((item) => item.id).sort());
    }
  });
});
