import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  LogisticsCompanyInputDto,
  LogisticsCompanyResponseDto,
  SignupLogisticsCompanyChoiceResponseDto,
} from './logistics-company.dto';
import {
  DuplicateLogisticsCompanyError,
  LogisticsCompaniesRepository,
} from './logistics-companies.repository';

@Injectable()
export class LogisticsCompaniesService {
  constructor(
    private readonly logisticsCompanies: LogisticsCompaniesRepository,
  ) {}

  findAll(): Promise<LogisticsCompanyResponseDto[]> {
    return this.logisticsCompanies.findAllActive();
  }

  findAllForSignup(): Promise<SignupLogisticsCompanyChoiceResponseDto[]> {
    return this.logisticsCompanies.findAllActiveForSignup();
  }

  async findOne(id: string): Promise<LogisticsCompanyResponseDto> {
    const company = await this.logisticsCompanies.findActiveById(id);

    if (!company) {
      this.throwNotFound();
    }

    return company;
  }

  async create(
    input: LogisticsCompanyInputDto,
  ): Promise<LogisticsCompanyResponseDto> {
    try {
      return await this.logisticsCompanies.create(randomUUID(), input);
    } catch (error) {
      this.throwIfDuplicate(error);
      throw error;
    }
  }

  async update(
    id: string,
    input: LogisticsCompanyInputDto,
  ): Promise<LogisticsCompanyResponseDto> {
    try {
      const company = await this.logisticsCompanies.updateActive(id, input);

      if (!company) {
        this.throwNotFound();
      }

      return company;
    } catch (error) {
      this.throwIfDuplicate(error);
      throw error;
    }
  }

  async deactivate(id: string): Promise<void> {
    if (!(await this.logisticsCompanies.deactivateActive(id))) {
      this.throwNotFound();
    }
  }

  private throwIfDuplicate(error: unknown): void {
    if (error instanceof DuplicateLogisticsCompanyError) {
      throw new ConflictException({
        code: 'LOGISTICS_COMPANY_DUPLICATE',
        message: '이미 등록된 사업자 정보입니다.',
      });
    }
  }

  private throwNotFound(): never {
    throw new NotFoundException({
      code: 'LOGISTICS_COMPANY_NOT_FOUND',
      message: '물류사를 찾을 수 없습니다.',
    });
  }
}
