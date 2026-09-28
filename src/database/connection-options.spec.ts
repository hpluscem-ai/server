import { databaseSsl } from './connection-options';

describe('databaseSsl', () => {
  const originalCa = process.env.DATABASE_CA_CERT;

  afterEach(() => {
    if (originalCa === undefined) delete process.env.DATABASE_CA_CERT;
    else process.env.DATABASE_CA_CERT = originalCa;
  });

  it('uses a supplied private CA without disabling certificate verification', () => {
    process.env.DATABASE_CA_CERT = '  private-test-ca\n';
    expect(databaseSsl('postgres://postgres.railway.internal/db')).toEqual({
      ca: 'private-test-ca',
      rejectUnauthorized: true,
    });
    expect(databaseSsl('postgres://localhost/db')).toBe(false);
    expect(
      databaseSsl(
        'postgres://aws-0-ap-northeast-2.pooler.supabase.com:5432/db',
      ),
    ).toHaveProperty('ca', expect.stringContaining('BEGIN CERTIFICATE'));
    expect(() =>
      databaseSsl(
        'postgres://aws-0-ap-northeast-2.pooler.supabase.com:6543/db',
      ),
    ).toThrow('Session pooler');
  });

  it('keeps default trust for remote connections without a private CA', () => {
    delete process.env.DATABASE_CA_CERT;
    expect(databaseSsl('postgres://db.example.com/db')).toBe(true);
    process.env.DATABASE_CA_CERT = '  ';
    expect(databaseSsl('postgres://db.example.com/db')).toBe(true);
  });
});
