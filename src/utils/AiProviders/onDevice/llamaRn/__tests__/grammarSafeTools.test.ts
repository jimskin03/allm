import { grammarSafeSchema, grammarSafeTools, MAX_NATIVE_TOOLS } from '../grammarSafeTools';

test('keeps a simple object schema and drops grammar-hostile keywords', () => {
  const schema = {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
    additionalProperties: false,
    $defs: { example: { type: 'string', maxLength: 65536 } },
  };
  expect(grammarSafeSchema(schema)).toEqual({
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  });
  expect(schema.$defs).toBeDefined();
});

test('strips nested maxLength and pattern escapes that llama.cpp cannot parse', () => {
  const schema = grammarSafeSchema({
    type: 'object',
    properties: {
      job: {
        type: 'object',
        properties: {
          script: { type: 'string', minLength: 1, maxLength: 65536, pattern: '^(https:\\/\\/)?example\\.com\\/.+$' },
        },
        required: ['script'],
      },
    },
  });
  expect(schema.properties.job).toEqual({
    type: 'object',
    properties: { script: { type: 'string' } },
    required: ['script'],
  });
  expect(JSON.stringify(schema)).not.toMatch(/maxLength|minLength|pattern/);
});

test('inlines a local $ref and stops on a cycle', () => {
  const schema = grammarSafeSchema({
    type: 'object',
    properties: { node: { $ref: '#/$defs/node' } },
    required: ['node'],
    $defs: {
      node: {
        type: 'object',
        properties: { name: { type: 'string' }, child: { $ref: '#/$defs/node' } },
        required: ['name'],
      },
    },
  });
  expect(schema.properties.node.properties.name).toEqual({ type: 'string' });
  expect(schema.properties.node.properties.child).toEqual({ type: 'object' });
  expect(schema.properties.node.required).toEqual(['name']);
});

test('collapses anyOf to one branch and merges allOf object fields', () => {
  expect(grammarSafeSchema({
    type: 'object',
    properties: { value: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'integer' } } }] } },
  }).properties.value).toEqual({ type: 'object', properties: { id: { type: 'integer' } } });

  expect(grammarSafeSchema({
    type: 'object',
    allOf: [
      { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      { type: 'object', properties: { units: { type: 'string', enum: ['c', 'f'] } } },
    ],
  })).toEqual({
    type: 'object',
    properties: { city: { type: 'string' }, units: { type: 'string', enum: ['c', 'f'] } },
    required: ['city'],
  });
});

test('keeps required properties when the object has more fields than the grammar can hold', () => {
  const properties: Record<string, any> = {};
  const required = ['must'];
  for (let i = 0; i < 30; i++) properties[`opt${i}`] = { type: 'string', maxLength: 8000 };
  properties.must = { type: 'boolean' };
  const schema = grammarSafeSchema({ type: 'object', properties, required });
  expect(Object.keys(schema.properties)).toHaveLength(12);
  expect(schema.properties.must).toEqual({ type: 'boolean' });
  expect(schema.required).toEqual(['must']);
  expect(schema.properties.opt29).toBeUndefined();
});

test('caps how many tools are offered and shortens descriptions', () => {
  const tools = Array.from({ length: MAX_NATIVE_TOOLS + 4 }, (_, index) => ({
    type: 'function',
    function: {
      name: `tool_${index}`,
      description: 'x'.repeat(1000),
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  }));
  const safe = grammarSafeTools(tools);
  expect(safe).toHaveLength(MAX_NATIVE_TOOLS);
  expect(safe[0].function.name).toBe('tool_0');
  expect(safe[0].function.description.length).toBeLessThanOrEqual(400);
  expect(safe[0].function.parameters).toEqual({
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  });
  expect(tools[0].function.description).toHaveLength(1000);
});

test('a schema that is not an object becomes an empty parameter object', () => {
  expect(grammarSafeSchema('not json')).toEqual({ type: 'object', properties: {} });
  expect(grammarSafeSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} });
});
