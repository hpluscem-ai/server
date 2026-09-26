import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminSessionGuard } from '../admin-auth';
import { AuthSessionGuard } from '../auth';
import { ApiErrorResponseDto } from '../common/api-error-response.dto';
import {
  AdminStationListQueryDto,
  CreateStationDto,
  StationBoundsQueryDto,
  StationResponseDto,
  UpdateStationDto,
} from './station.dto';
import { StationsService } from './stations.service';

@Controller('admin/stations')
@ApiTags('Admin stations')
@UseGuards(AdminSessionGuard)
@ApiCookieAuth('admin-session')
@ApiBearerAuth('admin')
@ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'INVALID_ADMIN_SESSION',
})
@ApiInternalServerErrorResponse({
  type: ApiErrorResponseDto,
  description: 'INTERNAL_SERVER_ERROR',
})
@ApiBadRequestResponse({
  type: ApiErrorResponseDto,
  description:
    'VALIDATION_ERROR | INVALID_DATE_RANGE | BAD_REQUEST (주유소 ID 형식 오류)',
})
export class AdminStationsController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  @ApiOperation({
    summary: '주유소 목록',
    description:
      '주유소명·등록 기간 검색. 운영 여부와 관계없이 최신 등록순·동일 시각 ID순으로 조회합니다. 기간 생략 시 임의 기본값을 적용하지 않습니다. 기기는 부모 아래 배열로 제공합니다. 입력 좌표는 별도 검수 없이 반환하며 검증 출처·시각을 만들지 않습니다. 운영 상태 변경은 정책 미정으로 미제공입니다.',
  })
  @ApiOkResponse({ type: StationResponseDto, isArray: true })
  findAll(
    @Query() query: AdminStationListQueryDto,
  ): Promise<StationResponseDto[]> {
    return this.stations.findAdminList(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '수정용 주유소 상세 조회' })
  @ApiParam({ name: 'id', description: '주유소 식별자', format: 'uuid' })
  @ApiOkResponse({ type: StationResponseDto })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'STATION_NOT_FOUND',
  })
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<StationResponseDto> {
    return this.stations.findOne(id, false);
  }

  @Post()
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @ApiOperation({
    summary: '주유소 및 설치 기기 등록',
    description:
      '주유소와 1개 이상의 기기를 함께 저장하거나 함께 롤백합니다. 주소는 도로명 주소 하나로 저장합니다. 좌표는 미검증 상태로 저장하며 출처·확인 시각을 만들지 않습니다.',
  })
  @ApiCreatedResponse({ type: StationResponseDto })
  create(@Body() input: CreateStationDto): Promise<StationResponseDto> {
    return this.stations.create(input);
  }

  @Put(':id')
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @ApiOperation({
    summary: '주유소 및 설치 기기 수정',
    description:
      '전체 입력 필드를 저장합니다. 비고 생략은 비고 없음으로 저장합니다. 유지할 기존 기기는 ID를 포함하고 추가 기기는 ID를 생략합니다. 목록에서 빠진 기존 기기는 실제 삭제하며 최소 1개의 기기가 필요합니다. 타 주유소 기기·중복 ID는 거부합니다. 동시 전체 수정은 마지막 저장된 기기 목록을 적용합니다. 주소·위도·경도 변경 시 기존 좌표 검증 정보를 해제합니다. 주유소와 기기의 변경·제거는 원자적입니다.',
  })
  @ApiParam({ name: 'id', description: '주유소 식별자', format: 'uuid' })
  @ApiOkResponse({ type: StationResponseDto })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'STATION_NOT_FOUND',
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'UNKNOWN_DEVICE | DUPLICATE_DEVICE_ID',
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateStationDto,
  ): Promise<StationResponseDto> {
    return this.stations.update(id, input);
  }

  @Delete(':id')
  @ApiForbiddenResponse({
    type: ApiErrorResponseDto,
    description: 'WEB_ORIGIN_NOT_ALLOWED',
  })
  @HttpCode(204)
  @ApiOperation({
    summary: '주유소 및 종속 기기 삭제',
    description:
      '주유소와 해당 주유소의 모든 기기를 함께 실제 삭제합니다. 다른 주유소·기사·영수·정산은 변경하지 않습니다. 없는 주유소와 반복 삭제는 404입니다. 복구 API는 제공하지 않습니다.',
  })
  @ApiParam({ name: 'id', description: '삭제할 주유소 식별자', format: 'uuid' })
  @ApiNoContentResponse({ description: '주유소 및 종속 기기 삭제 완료' })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'STATION_NOT_FOUND',
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    return this.stations.remove(id);
  }
}

@Controller('stations')
@ApiTags('Driver stations')
@UseGuards(AuthSessionGuard)
@ApiCookieAuth('driver-session')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiErrorResponseDto,
  description: 'INVALID_SESSION',
})
@ApiInternalServerErrorResponse({
  type: ApiErrorResponseDto,
  description: 'INTERNAL_SERVER_ERROR',
})
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  @ApiOperation({
    summary: '기사용 운영 주유소 목록',
    description:
      '운영 중인 주유소만 최신 등록순·동일 시각 ID순으로 반환합니다. 입력된 좌표는 별도 검수 없이 제공하며 없는 좌표는 null입니다. 검증 완료로 가장하지 않고 coordinateVerified는 기존 검증 정보 유무를 나타냅니다. 기기는 운영 여부와 함께 배열로 제공합니다. 캐시·증분 갱신은 미제공입니다.',
  })
  @ApiOkResponse({ type: StationResponseDto, isArray: true })
  findAll(): Promise<StationResponseDto[]> {
    return this.stations.findAppList();
  }

  @Get('map')
  @ApiOperation({
    summary: '지도 경계 안의 운영 주유소 조회',
    description:
      '남서·북동 경계의 양 끝을 포함합니다. 실제 입력 좌표가 있는 운영 주유소를 별도 검수 없이 제공합니다. 좌표가 없는 주유소는 제외하고 검증 출처·시각을 만들지 않습니다. 확대 단계별 클러스터와 최대 응답 수 정책은 미정으로 미제공입니다. 사용자 현재 위치는 받지 않습니다.',
  })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR | INVALID_MAP_BOUNDS',
  })
  @ApiOkResponse({ type: StationResponseDto, isArray: true })
  findMap(
    @Query() query: StationBoundsQueryDto,
  ): Promise<StationResponseDto[]> {
    return this.stations.findMap(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '기사용 운영 주유소 상세',
    description:
      '입력 좌표는 별도 검수 없이 제공하며 좌표가 없으면 null입니다. 운영 중이 아니거나 삭제/없는 주유소는 404로 반환합니다.',
  })
  @ApiParam({ name: 'id', description: '주유소 식별자', format: 'uuid' })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'STATION_NOT_FOUND',
  })
  @ApiOkResponse({ type: StationResponseDto })
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<StationResponseDto> {
    return this.stations.findOne(id, true);
  }
}
