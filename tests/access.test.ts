import { it, expect } from 'vitest';
import { Store } from '../src/core/store.js';
import { Access, allowedRequest } from '../src/server/access.js';
it('pairs a browser once, stores only hashes and supports revocation', () => {
  const store = new Store(':memory:'),
    access = new Access(store, 'root-secret');
  const link = access.pairing('Phone', 'https://review.example');
  const code = link.url.split('#pair/')[1];
  const device = access.consume(code);
  expect(access.validate(device.token)).toBe(true);
  expect(access.validate('wrong')).toBe(false);
  expect(() => access.consume(code)).toThrow(/expired|already/);
  expect(JSON.stringify(store.db.prepare('SELECT * FROM devices').all())).not.toContain(
    device.token,
  );
  access.revoke(device.id);
  expect(access.validate(device.token)).toBe(false);
  expect(access.validate('root-secret')).toBe(true);
  store.close();
});
it('permits an explicit HTTPS proxy origin without permitting arbitrary origins or hosts', () => {
  expect(allowedRequest('127.0.0.1:4317', 'https://review.example', 'https://review.example')).toBe(
    true,
  );
  expect(allowedRequest('review.example', 'https://review.example', 'https://review.example')).toBe(
    true,
  );
  expect(allowedRequest('review.example', 'https://evil.example', 'https://review.example')).toBe(
    false,
  );
  expect(allowedRequest('review.example', 'http://review.example', 'https://review.example')).toBe(
    false,
  );
  expect(allowedRequest('evil.example', undefined, 'https://review.example')).toBe(false);
  expect(allowedRequest('review.example@evil.example', undefined, 'https://review.example')).toBe(
    false,
  );
});
it('does not accept an expired phone link', () => {
  const store = new Store(':memory:'),
    access = new Access(store, 'root');
  const code = access.pairing('Phone', 'https://review.example').url.split('#pair/')[1];
  store.db.prepare("UPDATE pairings SET expires_at='2000-01-01T00:00:00Z'").run();
  expect(() => access.consume(code)).toThrow(/expired/);
  store.close();
});
