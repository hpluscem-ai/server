import {
  Body,
  Controller,
  Get,
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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
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
      '주유소명·등록 기간 검색. 운영 여부와 관계없이 최신 등록순·동일 시각 ID순으로 조회합니다. 기간 생략 시 임의 기본값을 적용하지 않습니다. 기기는 부모 아래 배열로 제공합니다. 미검증 입력 좌표도 관리자에게는 검증 여부와 함께 반환합니다. 삭제·운영 상태 변경은 정책 미정으로 미제공입니다.',
  })
  @ApiOkResponse({ type: StationResponseDto, isArray: true })
  findAll(@Query() query: AdminStationListQueryDto): StationResponseDto[] {
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
  ): StationResponseDto {
    return this.stations.findOne(id, false);
  }

  @Post()
  @ApiOperation({
    summary: '주유소 및 설치 기기 등록',
    description:
      '주유소와 1개 이상의 기기를 함께 저장하거나 함께 롤백합니다. 소재지·주유소/직판 구분은 실제 값이 필수입니다. 좌표는 미검증 상태로 저장하며 출처·확인 시각을 만들지 않습니다.',
  })
  @ApiCreatedResponse({ type: StationResponseDto })
  create(@Body() input: CreateStationDto): StationResponseDto {
    return this.stations.create(input);
  }

  @Put(':id')
  @ApiOperation({
    summary: '주유소 및 설치 기기 수정',
    description:
      '전체 입력 필드를 저장합니다. 비고 생략은 비고 없음으로 저장합니다. 기존 기기는 ID를 모두 포함하고 추가 기기만 ID를 생략합니다. 기기 제거는 미지원이며 생략·타 주유소 기기·중복 ID는 거부합니다. 주소·위도·경도 변경 시 기존 좌표 검증 정보를 해제합니다. 주유소와 기기의 변경은 원자적입니다.',
  })
  @ApiParam({ name: 'id', description: '주유소 식별자', format: 'uuid' })
  @ApiOkResponse({ type: StationResponseDto })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description: 'STATION_NOT_FOUND',
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description:
      'UNKNOWN_DEVICE | DUPLICATE_DEVICE_ID | DEVICE_REMOVAL_NOT_SUPPORTED',
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateStationDto,
  ): StationResponseDto {
    return this.stations.update(id, input);
  }
}

@Controller('stations')
@ApiTags('Driver stations')
@UseGuards(AuthSessionGuard)
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
      '운영 중인 주유소만 최신 등록순·동일 시각 ID순으로 반환합니다. 미검증 좌표와 검증 정보는 null이며 길안내에 사용할 수 없습니다. 기기는 운영 여부와 함께 배열로 제공합니다. 캐시·증분 갱신은 미제공입니다.',
  })
  @ApiOkResponse({ type: StationResponseDto, isArray: true })
  findAll(): StationResponseDto[] {
    return this.stations.findAppList();
  }

  @Get('map')
  @ApiOperation({
    summary: '지도 경계 안의 검증된 운영 주유소 조회',
    description:
      '남서·북동 경계의 양 끝을 포함합니다. 좌표·출처·유효한 확인 시각을 갖춘 운영 주유소만 제공합니다. 검증 절차, 확대 단계별 클러스터와 최대 응답 수 정책은 미정으로 미제공입니다. 사용자 현재 위치는 받지 않습니다.',
  })
  @ApiBadRequestResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR | INVALID_MAP_BOUNDS',
  })
  @ApiOkResponse({ type: StationResponseDto, isArray: true })
  findMap(@Query() query: StationBoundsQueryDto): StationResponseDto[] {
    return this.stations.findMap(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '기사용 운영 주유소 상세',
    description:
      '미검증 좌표는 null입니다. 운영 중이 아니거나 없는 주유소는 404로 반환합니다.',
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
  ): StationResponseDto {
    return this.stations.findOne(id, true);
  }
}
