import { Module } from '@nestjs/common';
import {
  AdminStationsController,
  StationsController,
  StationsRepository,
  StationsService,
} from './stations';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  AuthController,
  AuthRepository,
  AuthService,
  SolapiSmsService,
  PostmarkEmailService,
} from './auth';
import { DatabaseService } from './database/database.service';
import {
  AdminDriversController,
  UsersController,
  UsersRepository,
  UsersService,
} from './users';
import {
  AdminAuthController,
  AdminAuthRepository,
  AdminAuthService,
} from './admin-auth';
import {
  LogisticsCompaniesController,
  LogisticsCompaniesRepository,
  LogisticsCompaniesService,
  SignupLogisticsCompaniesController,
} from './logistics-companies';

@Module({
  imports: [],
  controllers: [
    AdminStationsController,
    StationsController,
    AppController,
    LogisticsCompaniesController,
    SignupLogisticsCompaniesController,
    AuthController,
    UsersController,
    AdminDriversController,
    AdminAuthController,
  ],
  providers: [
    StationsRepository,
    StationsService,
    AppService,
    DatabaseService,
    LogisticsCompaniesRepository,
    LogisticsCompaniesService,
    AuthRepository,
    AuthService,
    SolapiSmsService,
    PostmarkEmailService,
    UsersRepository,
    UsersService,
    AdminAuthRepository,
    AdminAuthService,
  ],
})
export class AppModule {}
