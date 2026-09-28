import { describe, expect, it } from "vitest";
import { CONTINUATION_NOTE, continuationTemplate, renderTemplate } from "./render.ts";

const TEMPLATE = `Eres el paso **implement**. Haz el cambio.

## Ticket
{{ticket}}

## Plan
{{output.plan}}

## Correcciones pedidas por review/QA
{{feedback}}

Sigue el plan de {{output.plan}} y el ticket.
`;

describe("continuationTemplate", () => {
  it("drops the sections the session already holds and keeps the instructions and the new data", () => {
    const template = continuationTemplate(TEMPLATE, new Set(["ticket", "output.plan"]));
    expect(template.startsWith(`${CONTINUATION_NOTE}\n\nEres el paso **implement**.`)).toBe(true);
    expect(template).not.toContain("## Ticket");
    expect(template).not.toContain("## Plan");
    expect(template).toContain("## Correcciones pedidas por review/QA\n{{feedback}}");
    // Inline uses cannot be dropped without breaking the sentence: they point back instead.
    expect(template).toContain("Sigue el plan de (ya está en esta conversación) y el ticket.");

    const rendered = renderTemplate(template, { ticket: "#1 Botón", "output.plan": "PLAN", feedback: "arregla el lint" });
    expect(rendered).not.toContain("#1 Botón");
    expect(rendered).not.toContain("PLAN");
    expect(rendered).toContain("arregla el lint");
  });

  it("keeps every section when the session knows nothing yet", () => {
    const template = continuationTemplate(TEMPLATE, new Set());
    expect(template).toContain("## Ticket\n{{ticket}}");
    expect(template).toContain("## Plan\n{{output.plan}}");
  });
});
