import { AdminMileageController, AdminMileageService } from './admin-mileage';
import {
  MileageController,
  MileageRepository,
  MileageService,
  PhotoProcessorService,
  PhotoStorageService,
} from './mileage';
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
  ResendEmailService,
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
    AdminMileageController,
    MileageController,
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
    AdminMileageService,
    MileageRepository,
    MileageService,
    PhotoProcessorService,
    PhotoStorageService,
    StationsRepository,
    StationsService,
    AppService,
    DatabaseService,
    LogisticsCompaniesRepository,
    LogisticsCompaniesService,
    AuthRepository,
    AuthService,
    SolapiSmsService,
    ResendEmailService,
    UsersRepository,
    UsersService,
    AdminAuthRepository,
    AdminAuthService,
  ],
})
export class AppModule {}
