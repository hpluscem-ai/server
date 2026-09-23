import { BadRequestException } from '@nestjs/common';

export function invalid(code = 'SETTLEMENT_FILE_INVALID'): never {
  throw new BadRequestException({
    code,
    message: '정산 조건 또는 파일 내용을 확인해주세요.',
  });
}

export function dayStart(day: string): string {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)) invalid('VALIDATION_ERROR');
  const date = new Date(`${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== day
  )
    invalid('VALIDATION_ERROR');
  return new Date(date.getTime() - 9 * 3600_000).toISOString();
}

export function monthEnd(month: string): string {
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) invalid('VALIDATION_ERROR');
  const next = new Date(`${month}-01T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return new Date(next.getTime() - 9 * 3600_000).toISOString();
}

export function integer(value: unknown): number {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
    invalid('SETTLEMENT_AMOUNT_INVALID');
  return number;
}

export function account(value: unknown): string {
  if (typeof value !== 'string' || !/^\d[\d -]*$/.test(value)) invalid();
  const result = value.replace(/[ -]/g, '');
  if (result.length > 32) invalid();
  return result;
}
