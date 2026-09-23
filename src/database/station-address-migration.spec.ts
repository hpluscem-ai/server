import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from './database.service';

it.each([
  [5, false],
  [6, false],
  [6, true],
] as const)(
  'preserves station/device data and rolls back column removal on failure (v%s, failure %s)',
  (version, fail) => {
    const previousPath = process.env.DATABASE_PATH;
    const directory = mkdtempSync(join(tmpdir(), 'station-address-migration-'));
    const path = join(directory, 'test.sqlite');
    let connection: DatabaseSync | undefined = new DatabaseSync(path);
    let service: DatabaseService | undefined;
    const sql = (file: string) => readFileSync(join(__dirname, file), 'utf8');
    try {
      for (const file of [
        'schema.sql',
        '002-auth-sessions.sql',
        '003-admin-sessions.sql',
        '004-phone-verification-owner.sql',
      ]) {
        connection.exec(sql(file));
      }
      const objects = connection
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name = 'users' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
        )
        .all() as { sql: string }[];
      connection.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
      connection.exec(sql('005-driver-withdrawal.sql'));
      for (const object of objects) connection.exec(object.sql);
      connection.exec('COMMIT; PRAGMA foreign_keys = ON;');
      if (version === 6) connection.exec(sql('006-mileage-uploads.sql'));
      connection.exec(`
        INSERT INTO installation_sites (id, pole, business_name, area, road_address, site_type, note, latitude, longitude)
        VALUES ('site', 'pole', '기존 주유소', '서울', '서울시 강남구 도로 1', 'direct_sales', '메모', -35, -127);
        INSERT INTO installation_site_devices (id, installation_site_id, model, capacity_liters, active)
        VALUES ('device-1', 'site', '모델1', 1000, 1), ('device-2', 'site', '모델2', 2000, 0);
      `);
      const originalStation = connection
        .prepare('SELECT * FROM installation_sites')
        .get()!;
      const originalDevices = connection
        .prepare('SELECT * FROM installation_site_devices ORDER BY id')
        .all();
      if (fail)
        connection.exec(
          'CREATE INDEX site_type_test_idx ON installation_sites(site_type);',
        );
      connection.close();
      connection = undefined;
      process.env.DATABASE_PATH = path;
      if (fail) {
        expect(() => new DatabaseService()).toThrow();
        connection = new DatabaseSync(path);
        expect(connection.prepare('PRAGMA user_version').get()).toEqual({
          user_version: 6,
        });
        expect(
          connection.prepare('SELECT * FROM installation_sites').get(),
        ).toEqual(originalStation);
      } else {
        service = new DatabaseService();
        const { area, site_type: siteType, ...preserved } = originalStation;
        expect(area).toBe('서울');
        expect(siteType).toBe('direct_sales');
        expect(
          service.connection.prepare('SELECT * FROM installation_sites').get(),
        ).toEqual(preserved);
        expect(service.connection.prepare('PRAGMA user_version').get()).toEqual(
          { user_version: 8 },
        );
        expect(service.connection.prepare('PRAGMA foreign_keys').get()).toEqual(
          { foreign_keys: 1 },
        );
        service.onModuleDestroy();
        service = new DatabaseService();
        expect(
          service.connection.prepare('SELECT * FROM installation_sites').get(),
        ).toEqual(preserved);
      }
      const checked = service?.connection ?? connection!;
      expect(
        checked
          .prepare('SELECT * FROM installation_site_devices ORDER BY id')
          .all(),
      ).toEqual(originalDevices);
      expect(checked.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (!fail) {
        checked.exec("DELETE FROM installation_sites WHERE id = 'site'");
        expect(
          checked.prepare('SELECT * FROM installation_site_devices').all(),
        ).toEqual([]);
      }
    } finally {
      service?.onModuleDestroy();
      connection?.close();
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
