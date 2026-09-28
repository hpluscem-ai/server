<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## PostgreSQL and private S3 storage configuration

Local and deployed servers use PostgreSQL through Drizzle and `postgres`. Copy `.env.example` to `.env` and set `DATABASE_URL`; there is no local file database fallback. Existing Nest authentication and API contracts are unchanged; Supabase Auth and the browser Data API are not used.

- Runtime: deployed Railway services use the PostgreSQL private URL in the same project/environment. For Supabase connections, use the Session pooler (5432) or Direct URL; its shared Transaction pooler (6543) is incompatible with Postgres.js pipelining and is rejected. Vercel uses one connection per warm instance; a persistent server uses a pool of five. Prepared statements remain disabled.
- Remote runtime and migration connections require TLS with certificate and hostname verification; only loopback development connections use plaintext. The public Supabase Root 2021 CA from the official Dashboard download is bundled for Supabase database hosts. Other PostgreSQL hosts use Node's trusted roots by default. Set `DATABASE_CA_CERT` to a private root CA PEM for Railway internal PostgreSQL; the runtime, migration command and transfer verifier share this setting. Supabase hosts continue using the bundled Supabase CA. Do not disable certificate verification.
- Migrations: set `DATABASE_MIGRATION_URL` to a Direct or Session pooler connection, then run `pnpm db:migrate` before starting the server. Startup does not create or migrate tables. The initial migration targets an empty application schema; it does not import legacy data.
- Application tables live in the private `app` schema. Do not expose this schema through the Supabase Data API or grant `anon` / `authenticated` access. Database credentials stay on the API server.
- Tests: set `TEST_DATABASE_URL` to a dedicated local PostgreSQL database with permission to create databases. Each test application gets its own randomly named database, migrates it, and drops only that database on close. Tests never use `DATABASE_URL`.

```sh
pnpm db:migrate
pnpm build
pnpm exec jest --runInBand --watchman=false
pnpm exec jest --config test/jest-e2e.json --runInBand --watchman=false
```

Keep existing database files and photo objects until a separate data transfer has reconciled record counts, financial totals, relationships and photo keys. Changing configuration does not transfer data. For a cutover, stop writes or reconcile changes made after the snapshot before switching the API connection.

See the official [PostgreSQL connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) and [S3 configuration guide](https://supabase.com/docs/guides/storage/s3/authentication).

## Supabase DB → Railway DB 이전

DB만 옮긴다. Supabase Storage의 버킷·사진 객체·`SUPABASE_S3_*`·`SUPABASE_STORAGE_BUCKET` 설정은 유지한다. DB 이전으로 사진이 복사되지 않으며, Storage를 쓰는 동안 Supabase 프로젝트를 삭제하지 않는다. 연결 주소·비밀번호 입력과 실제 운영 백업/복원은 운영자가 실행한다.

### 연결 준비

- Railway API와 PostgreSQL을 **같은 리전·프로젝트 환경**에 둔다. 서버의 `DATABASE_URL`과 `DATABASE_MIGRATION_URL`은 PostgreSQL의 내부 주소를 사용한다. 내부 DNS는 로컬 PC/빌드 단계에서 접근할 수 없으므로 마이그레이션은 해당 환경의 실행 단계에서 한다.
- Railway 공식 SSL 이미지의 루트 인증서 **`/var/lib/postgresql/data/certs/root.crt` 내용만** API의 `DATABASE_CA_CERT`에 실제 여러 줄 PEM으로 설정한다. 개인 키(`root.key`, `server.key`)를 복사하지 않는다. 현재 공식 이미지의 서버 인증서에는 내부 호스트 SAN이 포함되지만 실제 배포 인증서도 확인한다. 인증서 갱신 시 신뢰 CA도 확인한다. 인증서 오류가 나면 검증을 끄지 말고 CA/호스트를 맞춘다.
- API 인증/SMS/OCR/스토리지 관련 기존 비밀값은 유지한다. 복원 계정이 `app` 객체의 소유자가 되므로 런타임과 마이그레이션도 그 역할로 접속한다. 별도 역할을 쓸 때는 기존 RLS와 소유권 정책을 먼저 검토한다.
- 백업 도구와 원본/대상 PostgreSQL major 버전을 확인한다. 우선 같은 major 버전으로 옮기며 대상이 더 오래된 버전이면 진행하지 않는다. 로컬에 해당 버전의 `pg_dump`, `pg_restore`, `psql`, Node 및 이 저장소의 `pnpm install` 의존성이 필요하다.

2026-09-28 합성 DB로 PostgreSQL 17.11 → 18.6 이전도 검증했다. 클라이언트 18.6으로 현재 `app` 스키마를 덤프·복원한 뒤 전체 대조를 통과했다. PostgreSQL 18에서 추가된 NOT NULL 제약조건 카탈로그 행은 기존 열의 `attnotnull`로 비교하며, CHECK/FK의 적용 여부도 확인한다. 실제 운영 원본의 버전·확장과 데이터는 별도로 확인해야 한다.

로컬 작업에서는 Railway DB 서비스로 인증된 SSH 터널을 연다. Railway CLI에 키를 등록한 뒤 대시보드의 **Copy Service Instance ID** 값을 사용한다(일반 Service ID와 다름). 별도 터미널에서 아래 연결을 유지한다. 15432는 비어 있는 로컬 포트여야 한다.

```sh
ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 "${RAILWAY_DB_INSTANCE_ID:?}@ssh.railway.com"
```

운영자는 작업 터미널에 다음 환경변수를 직접 설정한다. 값을 채팅·Git·공유 로그에 붙이지 않는다. URL에 `sslmode` 등 연결 옵션을 넣지 않는다.

| 변수 | 용도 |
| --- | --- |
| `SOURCE_DATABASE_URL` | Supabase Direct 또는 Session pooler(5432) URL |
| `TARGET_DATABASE_URL` | Railway 계정/DB를 사용하되 호스트 `127.0.0.1`, 포트 `15432`인 터널 URL |

PostgreSQL 도구용으로 저장소 밖에 권한 `0600`인 연결 서비스 파일을 준비하고, 그 절대 경로를 `PGSERVICEFILE`로 설정한다. 아래 빈 값은 운영자가 채운다. `source`/`target`은 위 URL과 각각 같은 DB여야 한다. 비밀번호는 URL 인코딩하지 않은 실제 값을 입력한다. 명령 인수에 비밀번호가 들어간 URL을 전달하지 않는다.

```ini
[source]
host=
port=5432
dbname=
user=
password=
sslmode=verify-full
sslrootcert=

[target]
host=127.0.0.1
port=15432
dbname=
user=
password=
sslmode=disable
```

`source.sslrootcert`에는 Supabase 대시보드에서 받은 루트 인증서 파일의 절대 경로를 넣는다. 아래 복원 명령의 `sslmode=disable`은 이 **인증된 SSH 터널의 루프백 연결에만** 해당한다. 운영 API의 Railway 내부 연결은 위의 `DATABASE_CA_CERT`로 TLS 및 호스트 이름을 검증한다. 공개 TCP 프록시로 바꾸거나 인증서 검증을 생략하는 용도로 사용하지 않는다.

### 쓰기 중지 → 최종 백업 → 빈 DB 복원

먼저 별도 빈 DB에 리허설한다. 복사본에 연결된 API/OCR 워커는 시작하지 않는다. 최종 전환 때는 아래 순서를 지킨다.

1. 새 요청을 막고 현재 업로드·OCR 처리·정산 작업이 끝날 때까지 기다린다. Vercel, Railway, 로컬 등 원본에 연결하는 모든 API/워커를 중지한다. 조회 API도 세션의 `last_used_at`을 갱신하므로 GET 요청까지 멈춰야 한다.
2. 중지 상태에서 아래 최종 백업을 만든다. `app` 스키마 전체를 복사하므로 세션·OCR 대기 작업·사진 키·정산 트리거·시퀀스·`__drizzle_migrations`도 포함된다. Supabase의 `auth`/`storage` 스키마와 시스템 역할은 복사하지 않는다.
3. 대상은 `app` 스키마가 없는 빈 DB여야 한다. **복원 전에 `pnpm db:migrate`를 실행하지 않는다.** 기존 DB를 지우는 `--clean` 옵션은 사용하지 않는다.

각 블록이 성공한 뒤 다음 블록을 실행한다. 실패한 덤프는 복원하지 않는다. 덤프에는 개인정보/인증정보가 포함되므로 저장소 밖의 접근 제한 디렉터리에 보관한다.

```sh
umask 077
TRANSFER_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hpluseco-transfer.XXXXXX")
export TRANSFER_DUMP="$TRANSFER_DIR/app.dump"
(
  set -eu
  export PGSERVICEFILE="${PGSERVICEFILE:?}"
  test "$(psql --dbname=service=source -X -A -t -v ON_ERROR_STOP=1 -c "SELECT to_regclass('app.__drizzle_migrations') IS NOT NULL")" = t
  pg_dump --dbname=service=source --format=custom --schema=app --strict-names --file="$TRANSFER_DUMP"
  pg_restore --list "$TRANSFER_DUMP" >/dev/null
)
```

```sh
(
  set -eu
  export PGSERVICEFILE="${PGSERVICEFILE:?}"
  test -f "${TRANSFER_DUMP:?}"
  test "$(psql --dbname=service=target -X -A -t -v ON_ERROR_STOP=1 -c "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app')")" = t
  pg_restore --no-owner --no-privileges --single-transaction --exit-on-error --dbname=service=target "$TRANSFER_DUMP"
  psql --dbname=service=target -X -v ON_ERROR_STOP=1 -c 'ANALYZE'
)
```

복원은 한 트랜잭션으로 처리한다. 실패했거나 `app`이 이미 있다면 원인을 확인하고 새 빈 대상에서 재시도한다. 대상 운영 데이터를 삭제해서 재시도하지 않는다.

### 데이터 대조 및 전환

API/워커를 멈춘 상태에서 저장소 루트에서 실행한다. 이 명령은 `.env`를 자동으로 읽지 않는다. 읽기 전용 스냅샷으로 전체 행과 구조를 대조하며 원문 행/연결 주소를 출력하지 않는다. 원본과 대상은 서로 다른 DB여야 한다.

```sh
node -r ts-node/register scripts/verify-db-transfer.ts
```

`Database transfer verification passed`와 종료 코드 0을 모두 확인한다. 테이블·행 수·전체 데이터 해시(마이그레이션 이력/사진 키/금액 포함), 열·제약조건·인덱스·RLS·트리거·함수·시퀀스를 비교한다. 데이터 양에 따라 시간이 걸리며 양쪽 DB에 쓰기가 계속되면 전환 근거로 사용할 수 없다. 스토리지 객체의 실재 여부, 새 런타임 계정 권한 및 운영 TLS 연결은 이 대조만으로 검증되지 않는다.

운영자가 Railway API의 두 DB URL과 `DATABASE_CA_CERT`를 새 내부 DB로 설정한다. **검증 중에는 `MILEAGE_OCR_ENABLED=false`로 설정하고 일반 사용자 트래픽을 차단한 상태로** 같은 코드 버전을 시작한다. 복원된 마이그레이션 이력을 유지하고 이후 코드에 새 마이그레이션이 있을 때만 평소대로 `pnpm db:migrate`를 적용한다. 새 연결에서 서버 시작/인증서 검증, 로그인·세션 복원·내정보·마일리지·어드민 조회·기존 사진 읽기를 확인하고 `/users/me`, `/mileage/summary` 응답 시간을 이전과 비교한다. 최종 검증 후 트래픽을 열고 기록해 둔 기존 OCR 설정을 복구해 승인·정산 흐름도 확인한다. 구 서버 워커는 계속 중지해 둔다.

**롤백:** 새 DB에 쓰기가 발생하기 전에는 서버를 중지하고 이전 URL로 되돌릴 수 있다. 인증 조회의 세션 갱신도 새 쓰기다. 새 DB를 사용한 뒤에는 두 DB가 갈라지므로 모든 쓰기를 멈추고 변경분을 대조/복구한 다음 되돌린다. 단순히 예전 URL로 바꾸면 신규 신청·정산·정보 변경이 유실될 수 있다. 원본 DB와 최종 덤프는 대조 및 운영 확인이 끝날 때까지 보존한다.

공식 문서: [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html), [Railway SSH](https://docs.railway.com/cli/ssh), [Railway SSL 이미지](https://github.com/railwayapp-templates/postgres-ssl).

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).


## Mileage application API

`/api/v1/mileage/applications` uses the existing driver Bearer token or driver web cookie. Cookie writes require an allowed `WEB_ORIGINS` Origin. Administrator sessions cannot access these routes.

- `POST /`: multipart fields `idempotencyKey` (UUID v4), `receipt`, `meter`. Exactly one photo of each kind, at most 50 MiB and 60,000,000 source pixels per file. Actual JPEG/PNG/HEIC/HEIF decoding is required. A successful request returns `201` with a pending application; final monetary values stay `null` until an approval succeeds.
- `GET /`: own unsettled applications. `createdFrom` is inclusive and `createdBefore` exclusive, both timezone-qualified ISO timestamps. `order=desc|asc` (default `desc`), `limit=1..100` (default `20`), and the returned `nextCursor` provide stable timestamp/ID pagination. A cursor belongs to its date range and order. Completed settlements are excluded; pending transfers remain visible.
- `GET /:id`: own application details and protected photo API paths.
- `GET /:id/photos/receipt` or `/meter`: authenticated normalized JPEG with `Cache-Control: no-store`. Session and ownership are checked again after storage I/O. Other users, missing records and completed settlements return `404`; missing stored files/storage failures return `503`.

The same user/key/original bytes replay the existing application. Different original bytes with the same key return `409 IDEMPOTENCY_CONFLICT`. Keys remain with application records. Concurrent processing can return `503`; retry with the same key and the same original bytes. Photo acceptance does not promise approval; OCR uses the asynchronous worker described below.

Set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` for an existing private S3-compatible bucket. Set `S3_FORCE_PATH_STYLE=false` (the default) for new Railway buckets; use `true` only when the bucket's Credentials tab specifies path-style URLs. Values other than the exact strings `true` and `false` are rejected. Use the provider's actual S3 bucket name and signing region, not its display name or the API server's region. Credentials remain server-only; existing Nest session and photo ownership checks still protect access. Missing or invalid configuration fails photo operations with `503`. The server never provisions a bucket or enables public access. API tests replace the storage boundary and do not contact hosted storage.

For deployment compatibility, the old `SUPABASE_S3_ENDPOINT`, `SUPABASE_S3_REGION`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_S3_ACCESS_KEY_ID`, and `SUPABASE_S3_SECRET_ACCESS_KEY` bundle remains supported with path-style URLs only when **none** of the six generic `S3_*` settings exists. Even a blank or partial generic configuration selects the new bundle and fails closed instead of mixing credentials from two stores.

Allow the existing exact maximum of 52,428,800 bytes (50 MiB) per photo in any provider upload limits. Use HTTPS for hosted storage. Local Supabase can use `http://127.0.0.1:54321/storage/v1/s3`, region `local`, and path-style URLs outside production. Preserve every original and normalized object key when transferring existing photos. A storage migration alone does not bypass Vercel's 4.5 MB function request limit; the production API now runs on Railway.

Originals and normalized copies remain private. Normalization corrects orientation, converts to sRGB JPEG quality 90, limits the long edge to 4096px and removes EXIF/GPS. Image decoding runs in a timed worker with bounded pixel/memory use; one decoder and at most two multipart requests run per server process. Excess concurrent requests return a retryable `503`. HEIC decoding uses ImageMagick WASM, retaining its source color profile through conversion to sharp. The worker asset is copied by the Nest build.

The PostgreSQL schema includes request fingerprints, original-photo metadata and `mileage_upload_attempts`. An attempt with all candidate storage keys is recorded before remote writes. Application/photo metadata and removal of the attempt commit together. Failed attempts retain their records, including ambiguous remote writes; cleanup only targets that attempt's uncommitted objects. A process interruption may leave an attempt requiring manual reconciliation. There is no automatic retention or deletion job, and accepted application/settlement records are preserved.

The committed HEIC test fixture is a generated solid-color image, not a user receipt. Hosted credentials, bucket configuration and hosted upload/read validation are separate from the isolated tests.

### Supabase Storage → Railway Bucket 이전

1. Deploy the compatible server code while only the old Supabase settings exist. Create a private Railway bucket in Singapore (`sin`), matching the API region. Keep the original bucket and its credentials during the transfer.
2. The operator stages the six `S3_*` settings on the API service with `railway variable set --skip-deploys`. Map the bucket's `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` through Railway variable references. Use the Credentials tab's URL style. Do not deploy the new settings before copying the objects.
3. Keep the API running as requested for the live transfer. Do not run `railway down`. A live copy is a preliminary copy, not a consistent final snapshot: new uploads and failed-upload cleanup may occur during listing and verification.
4. With both storage configurations supplied to the operator's local process, run `bash scripts/copy-photo-storage.sh`. It uses `rclone copy --immutable --metadata`, keeps the source, preserves object keys, and then uses `rclone check --download --one-way` to compare the actual bytes of source objects. New destination-only uploads are retained and do not fail comparison. It prints only counts and a result; detailed errors remain in a private local log. `rclone` must be installed separately. Never use `sync`, `purge`, or `delete` for this transfer.
5. Before changing active writes, resolve the live-read transition: a successful preliminary copy alone cannot guarantee that a later source upload is already available on the destination. After all source-writing deployments have been replaced, repeat the copy and compare the DB's `storage_key` and `original_storage_key` references with destination objects. Reconcile unfinished upload attempts before declaring completion. Verify an existing driver/admin photo plus a new upload/read/delete of a synthetic object. Application and admin API paths remain unchanged; neither client receives storage credentials.
6. Only after validation remove the old server-side Supabase storage settings. Keep the source while investigating any failure. After new uploads begin on Railway, changing back to Supabase without copying those new objects would leave broken DB references. Supabase project deletion is a separate action after both DB and Storage dependencies have been removed; check local development configuration separately.

Run `python3 scripts/check-copy-photo-storage.py` for the transfer script's synthetic command-order and failure checks; it does not access hosted storage or real credentials.

References: [Railway buckets](https://docs.railway.com/storage-buckets), [rclone copy](https://rclone.org/commands/rclone_copy/), [rclone check](https://rclone.org/commands/rclone_check/).

## OCR automatic approval (disabled by default)

The PostgreSQL-backed worker reads receipts and meters with `gpt-6-luna`. `MILEAGE_OCR_ENABLED`, `OPENAI_API_KEY` and a positive `MILEAGE_OCR_LUNA_DAILY_LIMIT` control paid reading. `MILEAGE_OCR_AUTO_APPROVE_ENABLED=true` is a separate, exact opt-in; missing, false or misspelled values disable automatic approval.

Before each OCR request, images larger than 2048px on either edge are resized in memory to fit within 2048×2048, preserving aspect ratio, and encoded as JPEG quality 90. Smaller images pass through unchanged. This applies to initial and mirror-correction requests; originals and stored 4096px normalized copies remain unchanged. It reduces server-to-OCR payloads, not client upload sizes or the Vercel upload limit.

Each server process handles at most two OCR jobs concurrently and polls the queue every five seconds. Claiming a job starts a two-minute lease using the database clock; the worker renews it every ten seconds while processing. Only expired leases (or legacy running jobs without a lease) become `unknown / INTERRUPTED`. Their paid-call reservations remain counted, and they are never automatically queued or charged again. Disabled OCR workers do not claim or interrupt jobs. Shutdown stops new claims and waits for active work. Multiple server processes multiply the total concurrency; photo upload/decoder limits are separate.

Before deploying the lease change, let active work finish and stop all old server processes, apply `pnpm db:migrate`, then start the updated processes. Old binaries still interrupt every running job on startup and must not overlap with the updated workers. The migration adds nullable `lease_expires_at` without changing existing job results or reservations. A persistent server is still required for polling and renewal; this change does not remove the existing Vercel hosting limitation.

For a current running job, `finishOcrJob` stores OCR evidence, completes the job and approves/credits the application in one database transaction. It requires the current extractor and photo version, the required photo(s), pending/unsettled state, no job/provider error, identical readable totals and explicit meter liters. `finalAmount` is the matching displayed total; `mileageAmount` is meter liters × 20, rounded with decimal integer arithmetic. Receipt quantity, document kind, reprint metadata, ancillary warnings and transaction timestamp availability do not gate approval. Unreadable amounts/liters must be null, never guessed. No amount-to-liter inference or automatic rejection is performed.

Timestamps without an offset use Korean time (`+09:00`). Missing seconds, ambiguous or impossible timestamps remain null without blocking readable matching amounts. Across all users (including withdrawn users), matching receipt amount, meter amount and transaction time, or the existing identical-photo request hash, trigger duplicate review. Independently, matching totals from the same driver's immediately previous current OCR result trigger duplicate review even if the transaction time differs. Results are ordered by completion time; another driver's result does not interrupt that sequence. A failed preceding OCR result does not cause a search for an older equal amount. Old submission evidence and creation hashes after resubmission are not treated as current photos. Repeated completion, resubmission, review and settlement do not rewrite a completed decision. Existing balances sum approved records; there is no separate increment or new queue.

The extractor evidence version changes with these validation rules. Old queued jobs are discarded before paid calls, and completed jobs are never automatically reread or retroactively approved. Each application sends one GPT-6 Luna request containing its combined photo or separate receipt/meter photos. If a photo is explicitly identified as mirrored, only that in-memory image is flipped and the request is repeated once. Both attempts reserve from `MILEAGE_OCR_LUNA_DAILY_LIMIT` (UTC day) before calling. Transport failures are not automatically retried. Cached and cache-write token counts are recorded in the job result. CLOVA credentials are no longer used; its historical columns remain readable.

### Reuse benchmark evidence

Use `scripts/benchmark-mileage-ocr.ts` with private absolute manifest/output paths outside the repository. Existing manifest amount/liter truth is preserved. Add `truth.transactionAt` (canonical UTC ISO timestamp), `truth.documentKind`, `truth.uncertain` and the human-labelled `truth.autoApprove`. A missing/null truth field is unknown, never an exact match. `truth.liters` is a decimal string without a unit. Approval candidates here test reading evidence only; production additionally checks database state and duplicates.

```sh
# Inspect unique pairs and maximum calls without contacting providers.
pnpm exec ts-node scripts/benchmark-mileage-ocr.ts --manifest /private/path/manifest.json --output /private/path/report.json
# Re-evaluate saved results without opening images or making new paid calls.
pnpm exec ts-node scripts/benchmark-mileage-ocr.ts --manifest /private/path/manifest.json --results /private/path/previous-results.json --output /private/path/review.json
```

Live evaluation additionally requires `--live`, `--max-luna-calls` and `--used-luna-calls`. Maxima are the approved cumulative ceilings; used counts include prior failures and uncertain attempts. The earlier 11-call ceilings are not a fresh allowance. Confirm remaining usage before supplying these values. Conflicting truths for duplicate pairs and insufficient budgets fail before calling. Attempt counts are saved before requests; atomic report replacements preserve the previous checkpoint on interruption. Existing output files are never used to start a new paid run. Reported calls are attempts/reservations, not proof of provider billing; use account usage/invoices for actual cost.

The evaluator reports amount, liter and timestamp accuracy separately. Approval verification uses labelled amounts/liters and the human-labelled decision; transaction time and document kind are informational. Unknown required truth cannot count as a verified approval. Automated tests use synthetic readings and provider doubles; they do not establish real labelled sample accuracy.

### Combined mileage photos

`photoMode=single` accepts one image in multipart `receipt`; `separate` (legacy default) accepts `receipt` and `meter`. Details include `photoMode`. Combined images have one original and one normalized storage object, with a single receipt photo row. Both existing protected photo endpoints refer to that same object so administrator review remains compatible. No public URLs are introduced.

A rejected application can change modes. Switching to single requires a new combined receipt image. Switching from single to separate requires both new images. Staying separate still allows replacing either image. Existing files are retained; idempotency, source versions, ownership and settlement guards remain in force.

### Administrator rejection reason

`POST /api/v1/admin/mileage/applications/:id/reject` requires `{ reviewVersion, rejectionReason }`. The reason is trimmed and must contain 1–150 characters. It is stored in the existing `rejection_reason` column and returned to the driver's detail view. Replaying the same version and reason preserves the decision timestamp; a different reason returns `409 MILEAGE_REVIEW_CONFLICT`. Existing historical reasons remain unchanged. Deploy the administrator form and API together; older clients that omit the reason receive a validation error. No database migration is required.

The PostgreSQL baseline includes the photo mode and second Luna reservation timestamp. Apply the explicit database migration before starting the updated server. Configure `OPENAI_API_KEY`, `MILEAGE_OCR_ENABLED=true` and an approved positive `MILEAGE_OCR_LUNA_DAILY_LIMIT` to enable new OCR jobs. Automatic approval remains independently gated. The benchmark performs one pass only; the production worker handles mirrored correction.
