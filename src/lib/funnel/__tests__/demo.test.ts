/**
 * The demo video block (02 Phase 3). Unset means no block; anything that is
 * not https is refused, so an env var typo can never put a script in the page.
 */
import { describe, expect, it } from "vitest";
import { demoEmbed } from "@/lib/funnel/demo";

describe("demoEmbed", () => {
  it("hides the block when unset", () => {
    expect(demoEmbed(undefined)).toBeNull();
    expect(demoEmbed(null)).toBeNull();
    expect(demoEmbed("  ")).toBeNull();
  });

  it("plays a video file in a <video>, anything else in an iframe", () => {
    expect(demoEmbed("https://cdn.example.com/demo.MP4")).toEqual({
      kind: "video",
      src: "https://cdn.example.com/demo.MP4",
    });
    expect(demoEmbed("https://www.loom.com/embed/abc123")).toEqual({
      kind: "iframe",
      src: "https://www.loom.com/embed/abc123",
    });
  });

  it("refuses anything that is not https", () => {
    expect(demoEmbed("http://example.com/demo.mp4")).toBeNull();
    expect(demoEmbed("javascript:alert(1)")).toBeNull();
    expect(demoEmbed("data:text/html,hi")).toBeNull();
    expect(demoEmbed("not a url")).toBeNull();
  });
});
