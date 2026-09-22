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

- `POST /`: multipart fields `idempotencyKey` (UUID v4), `receipt`, `meter`. Exactly one photo of each kind, at most 50 MiB and 60,000,000 source pixels per file. Actual JPEG/PNG/HEIC/HEIF decoding is required. A successful request returns `201` with a pending application; monetary values stay `null` until a later approval workflow exists.
- `GET /`: own unsettled applications. `createdFrom` is inclusive and `createdBefore` exclusive, both timezone-qualified ISO timestamps. `order=desc|asc` (default `desc`), `limit=1..100` (default `20`), and the returned `nextCursor` provide stable timestamp/ID pagination. A cursor belongs to its date range and order. Completed settlements are excluded; pending transfers remain visible.
- `GET /:id`: own application details and protected photo API paths.
- `GET /:id/photos/receipt` or `/meter`: authenticated normalized JPEG with `Cache-Control: no-store`. Session and ownership are checked again after storage I/O. Other users, missing records and completed settlements return `404`; missing stored files/storage failures return `503`.

The same user/key/original bytes replay the existing application. Different original bytes with the same key return `409 IDEMPOTENCY_CONFLICT`. Keys remain with application records. Concurrent processing can return `503`; retry with the same key and the same original bytes. No edit, cancellation, rejection/resubmission, OCR, automatic approval or settlement mutation endpoint is included.

Set `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` for an existing private bucket. Keep public access disabled and scope credentials to that bucket. Missing configuration fails photo operations with `503`; startup and existing APIs continue to work. The server never provisions a bucket. Tests replace only the storage boundary and do not contact R2.

Originals and normalized copies remain private. Normalization corrects orientation, converts to sRGB JPEG quality 90, limits the long edge to 4096px and removes EXIF/GPS. Image decoding runs in a timed worker with bounded pixel/memory use; one decoder and at most two multipart requests run per server process. Excess concurrent requests return a retryable `503`. HEIC decoding uses ImageMagick WASM, retaining its source color profile through conversion to sharp. The worker asset is copied by the Nest build.

Schema migration 6 adds request fingerprints, original-photo metadata and `mileage_upload_attempts`. An attempt with all candidate storage keys is recorded before remote writes. Application/photo metadata and removal of the attempt commit together. Failed attempts retain their records, including ambiguous remote writes; cleanup only targets that attempt's uncommitted objects. A process interruption may leave an attempt requiring manual reconciliation. There is no automatic retention or deletion job, and accepted application/settlement records are preserved.

The committed HEIC test fixture is a generated solid-color image, not a user receipt. Live R2 credentials, bucket configuration and live upload/read validation are separate from the isolated tests.
