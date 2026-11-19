/**
 * llama.cpp turns every tool schema into one GBNF grammar before it generates a token.
 * MCP schemas are written for cloud APIs and regularly produce a grammar the parser rejects
 * (`failed to parse grammar`) or a prompt that fills a phone-sized context (`Context is full`):
 *
 *  - a nested string `maxLength` of 2000 or more emits a repetition the parser refuses
 *  - a `pattern` that contains `\/` is copied into the grammar and fails to parse
 *  - `$ref` / `$defs` are expanded until the rule count passes the repetition cap
 *  - dozens of optional properties, or more than a handful of tools, do the same
 *
 * What we hand the model keeps the name, description, types and required keys. Constraints that
 * exist only to make the grammar smaller are removed. The remote server still validates arguments.
 */

/** Past this many tools the combined grammar fails even when each schema is small. */
export const MAX_NATIVE_TOOLS = 8;

const MAX_PROPERTIES = 12;
const MAX_DEPTH = 5;
const MAX_DESCRIPTION = 400;
const MAX_SCHEMA_DESCRIPTION = 160;
const MAX_ENUM = 12;
const MAX_ENUM_CHARS = 64;
const MAX_REF_DEPTH = 8;

const PRIMITIVE_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

function capText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function decodePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function lookupRef(root: any, ref: string): any | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node = root;
  for (const segment of ref.slice(2).split('/').map(decodePointer)) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

function primitiveType(type: any): string | undefined {
  const value = Array.isArray(type) ? type.find(item => item !== 'null') : type;
  return typeof value === 'string' && PRIMITIVE_TYPES.has(value) ? value : undefined;
}

function safeKey(key: string): boolean {
  if (key.length === 0 || key.length > 64 || key.includes('"') || key.includes('\\')) return false;
  for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) < 32) return false;
  return true;
}

function descriptionOf(schema: any, max: number): string | undefined {
  if (typeof schema?.description !== 'string') return undefined;
  const text = capText(schema.description, max);
  return text || undefined;
}

function enumValues(schema: any): any[] | undefined {
  if (!Array.isArray(schema?.enum)) return undefined;
  const values = schema.enum
    .filter((value: any) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .filter((value: any) => typeof value !== 'string' || (value.length > 0 && value.length <= MAX_ENUM_CHARS))
    .slice(0, MAX_ENUM);
  return values.length ? values : undefined;
}

/** Prefer a branch the model can fill in. Unions are how grammars blow up, so only one survives. */
function preferredBranch(branches: any[]): any {
  const score = (branch: any) => {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return 0;
    if (branch.type === 'object' || branch.properties) return 3;
    if (branch.type === 'array' || branch.items) return 2;
    if (branch.type || branch.enum) return 1;
    return 0;
  };
  return [...branches].sort((a, b) => score(b) - score(a))[0];
}

function mergeObjects(parts: any[]): any {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  let description: string | undefined;
  for (const part of parts) {
    if (!part || part.type !== 'object') continue;
    Object.assign(properties, part.properties ?? {});
    for (const key of part.required ?? []) if (!required.includes(key)) required.push(key);
    if (!description && part.description) description = part.description;
  }
  const names = [
    ...required.filter(key => key in properties),
    ...Object.keys(properties).filter(key => !required.includes(key)),
  ].slice(0, MAX_PROPERTIES);
  const kept: Record<string, any> = {};
  for (const name of names) kept[name] = properties[name];
  const result: any = { type: 'object', properties: kept };
  const keptRequired = required.filter(key => key in kept);
  if (keptRequired.length) result.required = keptRequired;
  if (description) result.description = description;
  return result;
}

function simplify(schema: any, depth: number, root: any, stack: string[]): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'string' };

  if (typeof schema.$ref === 'string') {
    if (stack.includes(schema.$ref) || stack.length >= MAX_REF_DEPTH) return { type: 'object' };
    const target = lookupRef(root, schema.$ref);
    if (!target || typeof target !== 'object') return { type: 'string' };
    return simplify(target, depth, root, [...stack, schema.$ref]);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return mergeObjects(schema.allOf.map((part: any) => simplify(part, depth, root, stack)));
  }
  const union = schema.anyOf || schema.oneOf;
  if (Array.isArray(union) && union.length) return simplify(preferredBranch(union), depth, root, stack);

  const type = primitiveType(schema.type);
  const description = descriptionOf(schema, MAX_SCHEMA_DESCRIPTION);
  const values = enumValues(schema);
  if (values && type !== 'object' && type !== 'array') {
    const result: any = { type: type ?? 'string', enum: values };
    if (description) result.description = description;
    return result;
  }

  if (depth >= MAX_DEPTH) return { type: type && type !== 'object' && type !== 'array' ? type : 'string' };

  const treatAsObject = type === 'object' || (type === undefined && schema.properties && typeof schema.properties === 'object');
  if (treatAsObject) {
    const source = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key: any) => typeof key === 'string' && safeKey(key)) : [];
    const names = [
      ...required.filter((key: string) => Object.prototype.hasOwnProperty.call(source, key)),
      ...Object.keys(source).filter(key => safeKey(key) && !required.includes(key)),
    ].slice(0, MAX_PROPERTIES);
    const properties: Record<string, any> = {};
    for (const name of names) properties[name] = simplify(source[name], depth + 1, root, stack);
    const result: any = { type: 'object', properties };
    const keptRequired = required.filter((key: string) => key in properties);
    if (keptRequired.length) result.required = keptRequired;
    if (description) result.description = description;
    return result;
  }

  if (type === 'array') {
    const items = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
      ? simplify(schema.items, depth + 1, root, stack)
      : { type: 'string' };
    const result: any = { type: 'array', items };
    if (description) result.description = description;
    return result;
  }

  const result: any = { type: type ?? 'string' };
  if (description) result.description = description;
  return result;
}

/** A JSON Schema reduced to the fragment llama.cpp can compile and a small model can read. */
export function grammarSafeSchema(schema: any): { type: 'object'; properties: Record<string, any>; required?: string[] } {
  let parsed = schema;
  if (typeof schema === 'string') {
    try { parsed = JSON.parse(schema); } catch { parsed = {}; }
  }
  const simplified = simplify(parsed && typeof parsed === 'object' ? parsed : {}, 0, parsed, []);
  if (simplified.type !== 'object') return { type: 'object', properties: {} };
  return simplified;
}

/** Tool list in rerank order, each schema safe to compile, capped at {@link MAX_NATIVE_TOOLS}. */
export function grammarSafeTools(tools: any[]): any[] {
  const safe: any[] = [];
  for (const tool of tools) {
    const fn = tool?.function;
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (!name) continue;
    const description = typeof fn.description === 'string' ? capText(fn.description, MAX_DESCRIPTION) : undefined;
    safe.push({
      ...tool,
      type: 'function',
      function: {
        ...fn,
        name,
        ...(description ? { description } : {}),
        parameters: grammarSafeSchema(fn.parameters),
      },
    });
    if (safe.length >= MAX_NATIVE_TOOLS) break;
  }
  return safe;
}
