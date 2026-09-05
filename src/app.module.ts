import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthController, AuthRepository, AuthService } from './auth';
import { DatabaseService } from './database/database.service';
import {
  LogisticsCompaniesController,
  LogisticsCompaniesRepository,
  LogisticsCompaniesService,
  SignupLogisticsCompaniesController,
} from './logistics-companies';

@Module({
  imports: [],
  controllers: [
    AppController,
    LogisticsCompaniesController,
    SignupLogisticsCompaniesController,
    AuthController,
  ],
  providers: [
    AppService,
    DatabaseService,
    LogisticsCompaniesRepository,
    LogisticsCompaniesService,
    AuthRepository,
    AuthService,
  ],
})
export class AppModule {}
