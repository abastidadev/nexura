type Schema = Record<string, any>;

/**
 * Minimal JSON Schema check for the agents without native structured output (Copilot):
 * `type`, `properties`, `required`, `additionalProperties: false`, `items` and `enum`,
 * which is what the steps' schema.json files use. Returns the problems found (empty = valid).
 */
export function checkJson(value: unknown, schema: Schema | undefined, path = "$"): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema["anyOf"])) {
    const options = schema["anyOf"] as Schema[];
    return options.some((option) => checkJson(value, option, path).length === 0) ? [] : [`${path}: no encaja en ninguna de las opciones`];
  }
  const types: string[] = schema["type"] === undefined ? [] : [schema["type"]].flat();
  if (types.length && !types.some((type) => matchesType(value, type))) {
    return [`${path}: se esperaba ${types.join(" | ")} y llegó ${describe(value)}`];
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((option: unknown) => option === value)) {
    return [`${path}: ${JSON.stringify(value)} no es uno de ${schema["enum"].map((option: unknown) => JSON.stringify(option)).join(", ")}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => checkJson(item, schema["items"], `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const properties: Schema = schema["properties"] ?? {};
    const problems = ((schema["required"] ?? []) as string[]).filter((name) => !(name in object)).map((name) => `${path}.${name}: falta`);
    for (const [name, item] of Object.entries(object)) {
      if (properties[name]) {
        problems.push(...checkJson(item, properties[name], `${path}.${name}`));
      } else if (schema["additionalProperties"] === false) {
        problems.push(`${path}.${name}: propiedad no permitida`);
      }
    }
    return problems;
  }
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/**
 * The JSON answer at the end of a free-text reply: the last ```json fenced block, or else
 * the last top-level `{...}` that parses. Undefined when there is none.
 */
export function extractJson(text: string): unknown {
  // The closing fence may follow the JSON on the same line (seen with Copilot).
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\s*```/g)].map((match) => match[1]!);
  for (const block of fenced.reverse()) {
    const parsed = tryParse(block);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const trimmed = text.trim();
  const whole = tryParse(trimmed);
  if (whole !== undefined) {
    return whole;
  }
  // Scan back from the last closing brace for a balanced object.
  const end = trimmed.lastIndexOf("}");
  for (let start = trimmed.lastIndexOf("{", end); start >= 0; start = trimmed.lastIndexOf("{", start - 1)) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}
