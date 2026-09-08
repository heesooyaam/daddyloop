import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { AppError, now } from '../core/types.js';
import { rememberSecret, safeEqual } from '../core/security.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class Access {
  constructor(
    private store: Store,
    private rootToken: string,
  ) {}
  validate(value: string) {
    if (safeEqual(value, this.rootToken)) return true;
    const device = this.store.db
      .prepare('SELECT id,expires_at FROM devices WHERE token_hash=? AND revoked=0')
      .get(digest(value));
    return !!device && String(device.expires_at) > now();
  }
  createDevice(name: string) {
    const token = rememberSecret(randomBytes(32).toString('hex')),
      id = randomUUID(),
      at = now();
    const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
    this.store.db
      .prepare(
        'INSERT INTO devices(id,name,token_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,?,0)',
      )
      .run(id, name, digest(token), at, expiresAt);
    return { id, token, expiresAt };
  }
  pairing(name: string, origin: string) {
    const code = randomBytes(24).toString('base64url'),
      expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    this.store.db
      .prepare('INSERT INTO pairings(code_hash,name,expires_at) VALUES(?,?,?)')
      .run(digest(code), name, expiresAt);
    return { url: `${origin}/#pair/${code}`, expiresAt };
  }
  consume(code: string) {
    return this.store.transaction(() => {
      const hash = digest(code),
        row = this.store.db
          .prepare('SELECT name,expires_at FROM pairings WHERE code_hash=?')
          .get(hash);
      if (!row || String(row.expires_at) <= now())
        throw new AppError(
          'pairing_invalid',
          'This pairing link expired or was already used. Generate a new link with reviewctl phone.',
          401,
        );
      this.store.db.prepare('DELETE FROM pairings WHERE code_hash=?').run(hash);
      return this.createDevice(String(row.name));
    });
  }
  devices() {
    return this.store.db
      .prepare('SELECT id,name,created_at,expires_at,revoked FROM devices ORDER BY created_at DESC')
      .all();
  }
  revoke(id: string) {
    this.store.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id);
  }
}
export function allowedRequest(
  host: string | undefined,
  origin: string | undefined,
  publicOrigin?: string,
) {
  if (!host || /[\s/@\\]/.test(host)) return false;
  let local: boolean;
  try {
    local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
  const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;
  if (!local && host !== publicHost) return false;
  if (origin && origin !== publicOrigin && !(local && origin === `http://${host}`)) return false;
  return true;
}
