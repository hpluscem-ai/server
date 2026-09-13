import { ForbiddenException } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';

export const WEB_SESSION_COOKIE = 'hpluseco_driver_session';

export function getWebOrigins(): string[] {
  const configured = process.env.WEB_ORIGINS?.trim();
  if (!configured) return [];
  return configured.split(',').map((entry) => {
    const value = entry.trim();
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      value.includes('*')
    ) {
      throw new Error('WEB_ORIGINS must contain only HTTP(S) origins.');
    }
    return url.origin;
  });
}

export function assertWebOrigin(request: Request): void {
  if (
    !request.headers.origin ||
    !getWebOrigins().includes(request.headers.origin)
  ) {
    throw new ForbiddenException({
      code: 'WEB_ORIGIN_NOT_ALLOWED',
      message: '허용된 웹 주소에서 다시 요청해 주세요.',
    });
  }
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/v1',
    secure: !['development', 'test'].includes(process.env.NODE_ENV ?? ''),
  };
}

export function readWebSession(request: Request): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${WEB_SESSION_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0].slice(WEB_SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function setWebSession(
  response: Response,
  token: string,
  expiresAt: string,
): void {
  response.cookie(WEB_SESSION_COOKIE, token, {
    ...cookieOptions(),
    expires: new Date(expiresAt),
  });
}

export function clearWebSession(response: Response): void {
  response.clearCookie(WEB_SESSION_COOKIE, cookieOptions());
}
