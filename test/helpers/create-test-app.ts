import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';

import { configureApp } from '../../src/app.setup';
import { AppModule } from '../../src/app.module';

export async function createTestApp(
  controllers: Type<unknown>[] = [],
): Promise<INestApplication<App>> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = ':memory:';
  let app: INestApplication<App> | undefined;

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers,
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();

    configureApp(app);
    await app.init();

    return app;
  } catch (error) {
    await app?.close();
    throw error;
  } finally {
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
  }
}
