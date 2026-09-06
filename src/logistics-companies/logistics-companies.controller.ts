import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  LogisticsCompanyInputDto,
  LogisticsCompanyResponseDto,
} from './logistics-company.dto';
import { LogisticsCompaniesService } from './logistics-companies.service';

@ApiTags('Admin logistics companies')
@Controller('admin/logistics-companies')
export class LogisticsCompaniesController {
  constructor(private readonly logisticsCompanies: LogisticsCompaniesService) {}

  @Get()
  @ApiOkResponse({ isArray: true, type: LogisticsCompanyResponseDto })
  findAll(): Promise<LogisticsCompanyResponseDto[]> {
    return this.logisticsCompanies.findAll();
  }

  @Get(':id')
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto })
  @ApiOkResponse({ type: LogisticsCompanyResponseDto })
  @ApiParam({ description: '물류사 식별자', format: 'uuid', name: 'id' })
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<LogisticsCompanyResponseDto> {
    return this.logisticsCompanies.findOne(id);
  }

  @Post()
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiConflictResponse({ type: ApiErrorResponseDto })
  @ApiCreatedResponse({ type: LogisticsCompanyResponseDto })
  create(
    @Body() input: LogisticsCompanyInputDto,
  ): Promise<LogisticsCompanyResponseDto> {
    return this.logisticsCompanies.create(input);
  }

  @Put(':id')
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiConflictResponse({ type: ApiErrorResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto })
  @ApiOkResponse({ type: LogisticsCompanyResponseDto })
  @ApiParam({ description: '물류사 식별자', format: 'uuid', name: 'id' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: LogisticsCompanyInputDto,
  ): Promise<LogisticsCompanyResponseDto> {
    return this.logisticsCompanies.update(id, input);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiNoContentResponse({
    description:
      '물류사를 비활성화하고 소속 기사의 모든 세션을 폐기합니다. 이후 상세 조회와 목록에서 반환되지 않습니다.',
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_SERVER_ERROR',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto })
  @ApiParam({ description: '물류사 식별자', format: 'uuid', name: 'id' })
  deactivate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): void {
    return this.logisticsCompanies.deactivate(id);
  }
}
