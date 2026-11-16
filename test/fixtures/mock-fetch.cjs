const assert = require('node:assert/strict');

const pending = JSON.parse(process.env.OP_TEST_REQUESTS);

// Every CLI request must match a fixture; tests never contact an OpenProject server.
globalThis.fetch = async (input, options = {}) => {
  const expected = pending.shift();
  assert.ok(expected, `Unexpected request: ${input}`);
  const url = new URL(input);
  assert.equal(url.origin, 'https://openproject.example.invalid');
  assert.equal(url.pathname, `/api/v3${expected.path}`);
  assert.equal(options.method || 'GET', expected.method || 'GET');
  const query = Object.fromEntries(url.searchParams);
  if (query.filters) query.filters = JSON.parse(query.filters);
  assert.deepEqual(query, expected.query || {});
  for (const [name, value] of Object.entries(expected.headers || {})) {
    assert.equal(new Headers(options.headers).get(name), value);
  }
  if (expected.body !== undefined) assert.equal(options.body, expected.body);

  const status = expected.status || 200;
  const body = status === 204 ? null : expected.text ?? JSON.stringify(expected.response);
  return new Response(body, {
    status,
    headers: { 'Content-Type': expected.contentType || 'application/hal+json' },
  });
};

process.on('exit', code => {
  if (code === 0 && pending.length) {
    console.error(`Missing ${pending.length} expected API request(s)`);
    process.exitCode = 1;
  }
});
