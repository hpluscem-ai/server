import { createHmac } from 'node:crypto';

import { SolapiSmsService } from './solapi-sms.service';

const dev = {
  apiKey: 'dev-test-key',
  apiSecret: 'dev-test-secret',
  sender: '0212345678',
};
const live = {
  apiKey: 'live-test-key',
  apiSecret: 'live-test-secret',
  sender: '0298765432',
};

describe('SOLAPI environment selection', () => {
  const service = new SolapiSmsService();
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      SOLAPI_API_KEY: dev.apiKey,
      SOLAPI_API_SECRET: dev.apiSecret,
      SOLAPI_SENDER_PHONE: dev.sender,
      SOLAPI_API_KEY_LIVE: live.apiKey,
      SOLAPI_API_SECRET_LIVE: live.apiSecret,
      SOLAPI_SENDER_PHONE_LIVE: live.sender,
    });
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        failedMessageList: [],
        messageList: [{ statusCode: '2000', messageId: 'test-message-id' }],
      }),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [undefined, undefined, dev],
    ['development', undefined, dev],
    ['test', undefined, dev],
    ['production', undefined, live],
    ['production', 'preview', dev],
    ['production', 'development', dev],
    ['development', 'production', live],
    ['production', 'production', live],
  ])(
    'uses matching key, secret and sender for NODE_ENV=%s, VERCEL_ENV=%s',
    async (nodeEnv, vercelEnv, credentials) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        NODE_ENV: nodeEnv,
        VERCEL_ENV: vercelEnv,
      });

      await service.sendVerificationCode('010-1234-5678', '123456');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0][1]!;
      const authorization = new Headers(init.headers).get('Authorization')!;
      const [, apiKey, date, salt, signature] = authorization.match(
        /^HMAC-SHA256 apiKey=(.+), date=(.+), salt=(.+), signature=(.+)$/,
      )!;
      expect(apiKey).toBe(credentials.apiKey);
      expect(signature).toBe(
        createHmac('sha256', credentials.apiSecret)
          .update(date + salt)
          .digest('hex'),
      );
      expect(JSON.parse(init.body as string)).toMatchObject({
        messages: [{ from: credentials.sender }],
      });
    },
  );

  it.each(['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER_PHONE'])(
    'never substitutes another environment when %s is missing',
    async (key) => {
      for (const environment of ['production', 'development']) {
        process.env.VERCEL_ENV = environment;
        const suffix = environment === 'production' ? '_LIVE' : '';
        const name = `${key}${suffix}`;
        const saved = process.env[name];
        delete process.env[name];

        await expect(
          service.sendVerificationCode('010-1234-5678', '123456'),
        ).rejects.toMatchObject({
          status: 503,
          response: { code: 'SMS_NOT_CONFIGURED' },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        process.env[name] = saved;
      }
    },
  );
});
