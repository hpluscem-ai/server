import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';
import {
  LogisticsCompaniesController,
  LogisticsCompaniesRepository,
  LogisticsCompaniesService,
} from './logistics-companies';

@Module({
  imports: [],
  controllers: [AppController, LogisticsCompaniesController],
  providers: [
    AppService,
    DatabaseService,
    LogisticsCompaniesRepository,
    LogisticsCompaniesService,
  ],
})
export class AppModule {}
