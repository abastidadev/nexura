import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text.ts";
import { parseAzureRemote } from "./repo-remote.ts";
import { openTicketsQuery } from "./work-items.ts";

describe("openTicketsQuery", () => {
  it("excludes closed states and task/test types, scoped to me or to the project", () => {
    const mine = openTicketsQuery("mine");
    expect(mine).toContain("[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')");
    expect(mine).toContain("'Task'");
    expect(mine).toContain("[System.AssignedTo] = @Me");
    expect(mine).toMatch(/ORDER BY \[System.ChangedDate\] DESC$/);
    expect(openTicketsQuery("project")).toContain("[System.TeamProject] = @project");
  });
});

describe("parseAzureRemote", () => {
  it("understands https, legacy visualstudio.com and ssh remotes", () => {
    const expected = { organization: "ags-devops", project: "Schedule", repository: "AGSAngularComponentLib" };
    expect(parseAzureRemote("https://ags-devops@dev.azure.com/ags-devops/Schedule/_git/AGSAngularComponentLib")).toEqual(expected);
    expect(parseAzureRemote("https://ags-devops.visualstudio.com/DefaultCollection/Schedule/_git/AGSAngularComponentLib")).toEqual(expected);
    expect(parseAzureRemote("git@ssh.dev.azure.com:v3/ags-devops/Schedule/AGSAngularComponentLib")).toEqual(expected);
    expect(parseAzureRemote("https://dev.azure.com/org/My%20Project/_git/repo")?.project).toBe("My Project");
    expect(parseAzureRemote("https://github.com/owner/repo.git")).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("keeps lists, headings and emphasis and drops markup", () => {
    const html =
      "<div><h2>Contexto</h2><p>El <b>badge</b> usa&nbsp;azul &amp; debe ser <code>verde</code>.</p><ul><li>Uno</li><li>Dos</li></ul><img src='x'><br>Fin</div>";
    expect(htmlToText(html)).toBe("## Contexto\nEl **badge** usa azul & debe ser `verde`.\n\n- Uno\n- Dos\n\n[imagen]\nFin");
    expect(htmlToText(undefined)).toBe("");
  });

  it("numbers ordered lists and ends every list with a blank line", () => {
    const html = "<ol><li>Llamar a <code>formatPrice(-150)</code></li><li>Devuelve <code>-2,-50 €</code></li></ol><p>Esperado: <code>-1,50 €</code></p>";
    expect(htmlToText(html)).toBe("1. Llamar a `formatPrice(-150)`\n2. Devuelve `-2,-50 €`\n\nEsperado: `-1,50 €`");
  });
});
