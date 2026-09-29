import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isEmail, isUUID } from 'class-validator';

@Injectable()
export class ResendEmailService {
  getResetConfiguration() {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const fromEmail = process.env.RESEND_FROM_EMAIL?.trim();
    const fromName = process.env.RESEND_FROM_NAME?.trim();
    const destination = process.env.PASSWORD_RESET_URL?.trim();
    let resetUrl: URL | undefined;
    try {
      if (destination) resetUrl = new URL(destination);
    } catch {
      // 잘못된 URL도 미설정과 같은 명시적 설정 오류로 처리한다.
    }
    const isLocalHttp =
      process.env.NODE_ENV !== 'production' &&
      resetUrl?.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(resetUrl.hostname);
    if (
      !apiKey ||
      !/^[\x21-\x7e]+$/.test(apiKey) ||
      apiKey === 're_xxxxxxxxx' ||
      !fromEmail ||
      !isEmail(fromEmail) ||
      !fromName ||
      /\p{Cc}/u.test(fromName) ||
      `${JSON.stringify(fromName)} <${fromEmail}>`.length > 255 ||
      !resetUrl ||
      (!['https:', 'hpluseco:'].includes(resetUrl.protocol) && !isLocalHttp) ||
      !resetUrl.hostname ||
      resetUrl.username ||
      resetUrl.password ||
      resetUrl.search ||
      resetUrl.hash
    ) {
      throw new ServiceUnavailableException({
        code: 'PASSWORD_RESET_EMAIL_NOT_CONFIGURED',
        message: '비밀번호 재설정 메일 설정이 준비되지 않았습니다.',
      });
    }
    return {
      apiKey,
      from: `${JSON.stringify(fromName)} <${fromEmail}>`,
      resetUrl,
    };
  }

  async sendPasswordReset(
    configuration: ReturnType<ResendEmailService['getResetConfiguration']>,
    recipient: string,
    token: string,
    withoutPhoneVerification = false,
  ): Promise<void> {
    const resetUrl = new URL(configuration.resetUrl);
    resetUrl.searchParams.set('token', token);
    try {
      if (!isEmail(recipient)) throw new Error('Invalid recipient');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${configuration.apiKey}`,
        },
        body: JSON.stringify({
          from: configuration.from,
          to: [recipient],
          subject: '[에이치플러스에코] 비밀번호 재설정',
          text: `아래 링크를 눌러 앱에서 비밀번호를 재설정해 주세요.\n${resetUrl.href}\n\n링크는 30분 동안 한 번만 사용할 수 있습니다.\n요청하지 않았다면 이 메일을 무시해 주세요.`,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok || !isAccepted(await response.json()))
        throw new Error('Email was not accepted');
    } catch {
      // 응답 원문에는 주소·링크·키가 포함될 수 있다. 타임아웃도 자동 재발송하지 않는다.
      throw new BadGatewayException({
        code: 'PASSWORD_RESET_EMAIL_SEND_FAILED',
        message: `메일 발송을 확인하지 못했습니다. ${withoutPhoneVerification ? '' : '휴대폰 인증 후 '}다시 요청해 주세요.`,
      });
    }
  }
}

function isAccepted(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    isUUID(value.id) &&
    !('name' in value) &&
    !('error' in value)
  );
}
