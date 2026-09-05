import { createHmac, randomBytes } from 'node:crypto';

import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

@Injectable()
export class SolapiSmsService {
  async sendVerificationCode(phone: string, code: string): Promise<void> {
    const apiKey = process.env.SOLAPI_API_KEY?.trim();
    const apiSecret = process.env.SOLAPI_API_SECRET?.trim();
    const sender = process.env.SOLAPI_SENDER_PHONE?.trim();

    if (!apiKey || !apiSecret || !sender || !/^\d{8,11}$/.test(sender)) {
      throw new ServiceUnavailableException({
        code: 'SMS_NOT_CONFIGURED',
        message: '문자 발송 설정이 준비되지 않았습니다.',
      });
    }

    const date = new Date().toISOString();
    const salt = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', apiSecret)
      .update(date + salt)
      .digest('hex');

    try {
      const response = await fetch(
        'https://api.solapi.com/messages/v4/send-many/detail',
        {
          method: 'POST',
          headers: {
            Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [
              {
                to: phone.replaceAll('-', ''),
                from: sender,
                text: `[에이치플러스에코] 인증번호 [${code}] (3분 이내 입력)`,
                type: 'SMS',
                autoTypeDetect: false,
              },
            ],
            showMessageList: true,
          }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        },
      );

      if (!response.ok || !isAccepted(await response.json())) {
        throw new Error('SMS was not accepted');
      }
    } catch {
      // Do not log provider errors: they may contain the recipient, OTP or credentials.
      // No automatic retry: a timeout can occur after a paid send was accepted.
      throw new BadGatewayException({
        code: 'SMS_SEND_FAILED',
        message: '인증번호 발송을 확인하지 못했습니다. 다시 요청해 주세요.',
      });
    }
  }
}

function isAccepted(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('failedMessageList' in value) ||
    !Array.isArray(value.failedMessageList) ||
    value.failedMessageList.length !== 0 ||
    !('messageList' in value) ||
    !Array.isArray(value.messageList) ||
    value.messageList.length !== 1
  ) {
    return false;
  }

  const message: unknown = value.messageList[0];
  return (
    typeof message === 'object' &&
    message !== null &&
    'statusCode' in message &&
    message.statusCode === '2000' &&
    'messageId' in message &&
    typeof message.messageId === 'string' &&
    message.messageId.length > 0
  );
}
