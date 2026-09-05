import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  if (existsSync('.env')) {
    loadEnvFile();
  }

  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 8080);
}
void bootstrap();
