import { SignUpRequestDto } from './auth-signup.dto';
import {
  AuthRepository,
  LogisticsCompanyUnavailableError,
} from './auth.repository';
import { AuthService } from './auth.service';
import { SolapiSmsService } from './solapi-sms.service';

describe('AuthService', () => {
  it('rejects a simultaneous proof use and releases it after a correctable failure', async () => {
    let rejectFirst!: (error: Error) => void;
    let persistedInput:
      Parameters<AuthRepository['createDriver']>[0] | undefined;
    const firstPrerequisite = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    const repository = {
      assertSignUpPrerequisites: jest
        .fn()
        .mockImplementationOnce(() => firstPrerequisite)
        .mockResolvedValueOnce(undefined),
      createDriver(input: Parameters<AuthRepository['createDriver']>[0]) {
        persistedInput = input;
        return 'new-driver-id';
      },
    };
    const service = new AuthService(
      repository as unknown as AuthRepository,
      new SolapiSmsService(),
    );
    const input: SignUpRequestDto = {
      email: 'driver@example.com',
      logisticsCompanyId: '11111111-1111-4111-8111-111111111111',
      marketingTerms: false,
      name: '홍길동',
      password: 'Password !123',
      phone: '010-1234-5678',
      privacyTerms: true,
      serviceTerms: true,
      verificationProof: 'same-proof',
    };

    const first = service.signUp(input);
    await Promise.resolve();
    const second = service.signUp({
      ...input,
      logisticsCompanyId: '22222222-2222-4222-8222-222222222222',
    });

    expect(repository.assertSignUpPrerequisites).toHaveBeenCalledTimes(1);
    await expect(second).rejects.toMatchObject({
      response: { code: 'PHONE_VERIFICATION_INVALID' },
      status: 400,
    });
    const firstResult = expect(first).rejects.toMatchObject({
      response: { code: 'LOGISTICS_COMPANY_UNAVAILABLE' },
      status: 400,
    });
    rejectFirst(new LogisticsCompanyUnavailableError());

    await firstResult;
    await expect(
      service.signUp({
        ...input,
        logisticsCompanyId: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toEqual({ id: 'new-driver-id' });
    expect(repository.assertSignUpPrerequisites).toHaveBeenCalledTimes(2);
    expect(Object.keys(persistedInput ?? {}).sort()).toEqual([
      'email',
      'id',
      'logisticsCompanyId',
      'marketingTerms',
      'name',
      'passwordHash',
      'phone',
      'privacyTerms',
      'proofHash',
      'serviceTerms',
    ]);
  });
});
