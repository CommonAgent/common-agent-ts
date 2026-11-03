// The page (Section 9.8): self-contained, readable without JavaScript, every
// section with its sources, silence shown as plainly as what was stated, no
// badge, and nothing presented above what the document's visibility allows.
import { describe, expect, it } from "vitest";
import { assemble } from "../assemble.js";
import { render } from "../render.js";
import { NOW, card, signedDescriptorText } from "./helpers.js";

describe("render", () => {
  it("is one self-contained page with no script and nothing fetched", async () => {
    const html = render(await assemble({ card: card(), descriptor: signedDescriptorText(), now: NOW }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script|<link |@import|onclick=/i);
    expect(html).not.toMatch(/agent ?mesh/i);
    expect(html.replace("It carries no score and no badge.", "")).not.toMatch(/\bscore\b|\bbadge\b|trust mark/i);
    expect(html).toContain("2026-11-03 12:00:00 UTC");
  });

  it("shows where each section came from, and what is not stated", async () => {
    const html = render(await assemble({ card: card(), now: NOW }));
    expect(html).toContain("from the agent card");
    expect(html).toContain("<code>access.admission</code>");
    expect(html).toContain("That is not a promise that it reaches nothing.");
    expect(html).toContain("It may still refuse you.");
    expect(html).toContain("That does not mean it is free.");
  });

  it("shows an absent door as not stated, never as open", async () => {
    const doc = await assemble({ card: card(), now: NOW });
    delete doc.sections.access;
    doc.not_stated.push("access");
    const html = render(doc);
    expect(html).toContain("That is not an open door.");
  });

  it("escapes what a source says", async () => {
    const html = render(await assemble({ card: card({ name: "<img src=x onerror=alert(1)>" }), now: NOW }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("shows a grant apart from a file, standing grants first", async () => {
    const desc = signedDescriptorText({
      offerings: [{
        id: "weekly-traffic", name: "Weekly traffic report", does: "Reports a week of traffic.",
        inputs: [{ name: "week", kind: "text", required: true }, { name: "property", kind: "identifier", required: true, external: true, access: "read", grant: "identity", provider: "google-analytics" }],
        outputs: [{ name: "report", kind: "text/markdown", when: "per_task" }],
      }],
    });
    const html = render(await assemble({ card: card({ skills: [] }), descriptor: desc, now: NOW }));
    expect(html).toContain("Access you grant, not files you send");
  });
});
