import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { SignupLogisticsCompanyChoiceResponseDto } from './logistics-company.dto';
import { LogisticsCompaniesService } from './logistics-companies.service';

@ApiTags('Signup logistics companies')
@Controller('logistics-companies')
export class SignupLogisticsCompaniesController {
  constructor(private readonly logisticsCompanies: LogisticsCompaniesService) {}

  @Get()
  @ApiOkResponse({
    description: '회원가입 시 선택 가능한 활성 물류사 목록',
    isArray: true,
    type: SignupLogisticsCompanyChoiceResponseDto,
  })
  findAll(): Promise<SignupLogisticsCompanyChoiceResponseDto[]> {
    return this.logisticsCompanies.findAllForSignup();
  }
}
