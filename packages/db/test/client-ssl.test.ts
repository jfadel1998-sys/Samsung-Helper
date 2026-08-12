import { describe, expect, it } from 'vitest';
import { wantsTls } from '../src/client';

describe('wantsTls', () => {
  it('is off for any spelling of a local database', () => {
    // Writing 127.0.0.1 instead of localhost used to surface as "socket
    // disconnected before secure TLS connection was established", which reads
    // like a network fault rather than a config choice.
    for (const url of [
      'postgres://hub@localhost:5432/hub',
      'postgres://hub@127.0.0.1:55432/hub_test',
      'postgres://hub@[::1]:5432/hub',
      'postgres://hub@LOCALHOST:5432/hub',
    ]) {
      expect(wantsTls(url), url).toBe(false);
    }
  });

  it('is on for a remote database', () => {
    expect(wantsTls('postgres://u:p@containers-us-west-1.railway.app:6543/railway')).toBe(true);
  });

  it('honours an explicit sslmode over the host', () => {
    expect(wantsTls('postgres://hub@localhost:5432/hub?sslmode=require')).toBe(true);
    expect(wantsTls('postgres://u:p@db.example.com:5432/x?sslmode=disable')).toBe(false);
  });

  it('defaults to TLS when the URL cannot be parsed', () => {
    // Failing closed: a malformed URL must not silently downgrade a production
    // connection to plaintext.
    expect(wantsTls('not a url')).toBe(true);
  });
});
