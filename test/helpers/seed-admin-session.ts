import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { DatabaseService } from '../../src/database/database.service';
import { adminSessions, users } from '../../src/database/schema';

// 격리된 테스트 DB 전용. 관리자 인증 자체는 admin-auth E2E에서 실제 로그인으로 검증한다.
export function seedAdminSession(database: DatabaseService): string {
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const now = new Date(Date.now());
  database.db
    .insert(users)
    .values({
      id: userId,
      role: 'admin',
      email: `${userId}@example.com`,
      name: '테스트 관리자',
      passwordHash: 'test-only-unused-hash',
    })
    .run();
  database.db
    .insert(adminSessions)
    .values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    })
    .run();
  return `Bearer ${token}`;
}
