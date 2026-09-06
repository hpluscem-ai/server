import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  AuthController,
  AuthRepository,
  AuthService,
  SolapiSmsService,
} from './auth';
import { DatabaseService } from './database/database.service';
import { UsersController, UsersRepository, UsersService } from './users';
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
    UsersController,
  ],
  providers: [
    AppService,
    DatabaseService,
    LogisticsCompaniesRepository,
    LogisticsCompaniesService,
    AuthRepository,
    AuthService,
    SolapiSmsService,
    UsersRepository,
    UsersService,
  ],
})
export class AppModule {}
