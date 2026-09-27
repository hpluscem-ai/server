import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';

import { configureApp } from '../../src/app.setup';
import { AppModule } from '../../src/app.module';
import { DatabaseService } from '../../src/database/database.service';

import { createTestDatabase } from './create-test-database';

export async function createTestApp(
  controllers: Type<unknown>[] = [],
  database?: DatabaseService,
): Promise<INestApplication<App>> {
  const testDatabase = database ?? (await createTestDatabase());
  let app: INestApplication<App> | undefined;

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers,
    })
      .overrideProvider(DatabaseService)
      .useValue(testDatabase)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();

    configureApp(app);
    await app.init();

    return app;
  } catch (error) {
    await app?.close();
    if (!app) await testDatabase.onApplicationShutdown();
    throw error;
  }
}
