import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isEmail, isUUID } from 'class-validator';

@Injectable()
export class PostmarkEmailService {
  getResetConfiguration() {
    const serverToken = process.env.POSTMARK_SERVER_TOKEN?.trim();
    const fromEmail = process.env.POSTMARK_FROM_EMAIL?.trim();
    const fromName = process.env.POSTMARK_FROM_NAME?.trim();
    const destination = process.env.PASSWORD_RESET_URL?.trim();
    let resetUrl: URL | undefined;
    try {
      if (destination) resetUrl = new URL(destination);
    } catch {
      // 잘못된 URL도 미설정과 같은 명시적 설정 오류로 처리한다.
    }
    if (
      !serverToken ||
      !/^[\x21-\x7e]+$/.test(serverToken) ||
      serverToken === 'POSTMARK_API_TEST' ||
      !fromEmail ||
      !isEmail(fromEmail) ||
      !fromName ||
      /\p{Cc}/u.test(fromName) ||
      `${JSON.stringify(fromName)} <${fromEmail}>`.length > 255 ||
      !resetUrl ||
      !['https:', 'hpluseco:'].includes(resetUrl.protocol) ||
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
      serverToken,
      from: `${JSON.stringify(fromName)} <${fromEmail}>`,
      resetUrl,
    };
  }

  async sendPasswordReset(
    configuration: ReturnType<PostmarkEmailService['getResetConfiguration']>,
    recipient: string,
    token: string,
  ): Promise<void> {
    const resetUrl = new URL(configuration.resetUrl);
    resetUrl.searchParams.set('token', token);
    try {
      if (!isEmail(recipient)) throw new Error('Invalid recipient');
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': configuration.serverToken,
        },
        body: JSON.stringify({
          From: configuration.from,
          To: recipient,
          Subject: '[에이치플러스에코] 비밀번호 재설정',
          TextBody: `아래 링크를 눌러 앱에서 비밀번호를 재설정해 주세요.\n${resetUrl.href}\n\n링크는 30분 동안 한 번만 사용할 수 있습니다.\n요청하지 않았다면 이 메일을 무시해 주세요.`,
          MessageStream: 'outbound',
          TrackOpens: false,
          TrackLinks: 'None',
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok || !isAccepted(await response.json(), recipient))
        throw new Error('Email was not accepted');
    } catch {
      // 응답 원문에는 주소·링크·키가 포함될 수 있다. 타임아웃도 자동 재발송하지 않는다.
      throw new BadGatewayException({
        code: 'PASSWORD_RESET_EMAIL_SEND_FAILED',
        message:
          '메일 발송을 확인하지 못했습니다. 휴대폰 인증 후 다시 요청해 주세요.',
      });
    }
  }
}

function isAccepted(value: unknown, recipient: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ErrorCode' in value &&
    value.ErrorCode === 0 &&
    'MessageID' in value &&
    typeof value.MessageID === 'string' &&
    isUUID(value.MessageID) &&
    'SubmittedAt' in value &&
    typeof value.SubmittedAt === 'string' &&
    Number.isFinite(Date.parse(value.SubmittedAt)) &&
    'To' in value &&
    typeof value.To === 'string' &&
    value.To.toLowerCase() === recipient.toLowerCase()
  );
}
