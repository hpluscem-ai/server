-- v1 -> v2: 로그인 세션 저장 구조만 추가한다. 기존 테이블과 데이터는 변경하지 않는다.
BEGIN IMMEDIATE;

CREATE TABLE auth_sessions (
  -- 인증 토큰 원문 대신 SHA-256 해시를 저장하고 세션 식별자로 사용한다.
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- UTC Unix 밀리초로 저장하며 Drizzle에서는 Date로 사용한다.
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (created_at <= last_used_at AND last_used_at < expires_at)
) STRICT;

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

PRAGMA user_version = 2;

COMMIT;
