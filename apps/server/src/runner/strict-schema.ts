type Schema = Record<string, any>;

/**
 * Codex's `--output-schema` uses OpenAI structured outputs in strict mode: every object needs
 * `additionalProperties: false` and must list all its properties as required. Optional
 * properties become nullable instead (and `fromStrictOutput` drops those nulls again).
 */
export function toStrictSchema(schema: Schema): Schema {
  if (Array.isArray(schema)) {
    return schema.map(toStrictSchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const result: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = key === "properties" || key === "$defs" || key === "definitions" ? mapValues(value, toStrictSchema) : toStrictSchema(value);
  }
  if (isObjectSchema(schema)) {
    const properties: Schema = result["properties"] ?? {};
    const required = new Set<string>(schema["required"] ?? []);
    for (const [name, property] of Object.entries(properties)) {
      if (!required.has(name)) {
        properties[name] = nullable(property as Schema);
      }
    }
    result["properties"] = properties;
    result["required"] = Object.keys(properties);
    result["additionalProperties"] = false;
  }
  return result;
}

/** Removes the nulls that strict mode forced into the optional properties of `schema`. */
export function fromStrictOutput(value: unknown, schema: Schema | undefined): unknown {
  if (!schema || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fromStrictOutput(item, schema["items"]));
  }
  const properties: Schema = schema["properties"] ?? {};
  const required = new Set<string>(schema["required"] ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null && !required.has(key)) {
      continue;
    }
    result[key] = fromStrictOutput(item, properties[key]);
  }
  return result;
}

function isObjectSchema(schema: Schema): boolean {
  return schema["type"] === "object" || (schema["properties"] !== undefined && schema["type"] === undefined);
}

function nullable(schema: Schema): Schema {
  const type = schema["type"];
  if (typeof type === "string") {
    return type === "null" ? schema : { ...schema, type: [type, "null"], ...(schema["enum"] ? { enum: [...schema["enum"], null] } : {}) };
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? schema : { ...schema, type: [...type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function mapValues(value: unknown, map: (item: Schema) => Schema): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item as Schema)]));
}
