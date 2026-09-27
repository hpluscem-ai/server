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

## PostgreSQL and Supabase configuration

Local and deployed servers use PostgreSQL through Drizzle and `postgres`. Copy `.env.example` to `.env` and set `DATABASE_URL`; there is no local file database fallback. Existing Nest authentication and API contracts are unchanged; Supabase Auth and the browser Data API are not used.

- Runtime: use the Supabase Session pooler URL (port 5432) with this Postgres.js driver. Supabase warns that Postgres.js pipelining is incompatible with its shared Transaction pooler (port 6543), which the server rejects. Vercel uses one connection per warm instance; a persistent server uses a pool of five. Prepared statements remain disabled. A persistent server can also use a Direct URL.
- Remote runtime and migration connections require TLS with certificate and hostname verification; only loopback development connections use plaintext. The public Supabase Root 2021 CA from the official Dashboard download is bundled for Supabase database hosts. Other PostgreSQL hosts use Node's trusted roots; a private CA can be supplied with `NODE_EXTRA_CA_CERTS` before starting the process. Do not disable certificate verification.
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

Set `SUPABASE_S3_ENDPOINT`, `SUPABASE_S3_REGION`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_S3_ACCESS_KEY_ID`, and `SUPABASE_S3_SECRET_ACCESS_KEY` for an existing private Supabase Storage bucket. Copy the endpoint, region and generated S3 key pair from Storage > S3; Auth/service-role keys are not S3 credentials. S3 keys bypass RLS and must remain server-only; existing Nest session and photo ownership checks still protect access. Missing or invalid configuration fails photo operations with `503`. The server never provisions a bucket or enables public access. API tests replace the storage boundary and do not contact hosted storage.

Set both the project and bucket upload limits to allow the existing exact maximum of 52,428,800 bytes (50 MiB) per photo. Use HTTPS for hosted storage. Local Supabase can use `http://127.0.0.1:54321/storage/v1/s3` and region `local` outside production. Preserve every original and normalized object key when transferring existing photos. A storage migration alone does not bypass Vercel's 4.5 MB function request limit; large multipart uploads and the persistent OCR worker still require the separately planned API hosting change.

Originals and normalized copies remain private. Normalization corrects orientation, converts to sRGB JPEG quality 90, limits the long edge to 4096px and removes EXIF/GPS. Image decoding runs in a timed worker with bounded pixel/memory use; one decoder and at most two multipart requests run per server process. Excess concurrent requests return a retryable `503`. HEIC decoding uses ImageMagick WASM, retaining its source color profile through conversion to sharp. The worker asset is copied by the Nest build.

The PostgreSQL schema includes request fingerprints, original-photo metadata and `mileage_upload_attempts`. An attempt with all candidate storage keys is recorded before remote writes. Application/photo metadata and removal of the attempt commit together. Failed attempts retain their records, including ambiguous remote writes; cleanup only targets that attempt's uncommitted objects. A process interruption may leave an attempt requiring manual reconciliation. There is no automatic retention or deletion job, and accepted application/settlement records are preserved.

The committed HEIC test fixture is a generated solid-color image, not a user receipt. Hosted Supabase credentials, bucket configuration and hosted upload/read validation are separate from the isolated tests.

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
