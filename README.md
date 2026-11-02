# CinemaHub user service

**Authentication, accounts, permissions, and session state for CinemaHub.**

Usernames, password hashes, profile fields, permissions, and session length are stored on the MongoDB user document. Request handling does not read or write operational JSON files.

The interface is [CinemaHub](https://github.com/maornetzer9/Movies). Movies, members, and subscriptions are served by [Movies-Subscription-Backend](https://github.com/maornetzer9/Movies-Subscription-Backend). Both APIs must use the same `SECRET_KEY` and the same database.

## Live demo

[CinemaHub](https://cinemahub-xi3w.onrender.com) · [This API](https://movies-user-backend.onrender.com/health)

This service has no interface. Product screenshots are in the [frontend repository](https://github.com/maornetzer9/Movies).

## Responsibilities

- Sign-in and demo registration
- Temporary passwords and the required first password change
- Administrator create, edit, and delete for users
- Permission lists and session timeout on the user document
- Disconnect, including locking a session by setting its timeout to `0`
- JWT issuance and `tokenVersion` checks shared with the catalog API
- Welcome email after an administrator creates an account

## Architecture

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 or newer |
| HTTP | Express 4, Helmet, CORS, express-rate-limit |
| Data | MongoDB through Mongoose |
| Auth | JWT and bcrypt |
| Mail | Nodemailer 10 for the administrator welcome email |

```text
routes → controllers → services → models / repositories
```

Controllers pass the request through. Services own the rules. Responses use `{ code, message, ...data }`. `code` is an HTTP status or a small domain code for a business error. Login failure stays HTTP 200 with body code `401`.

## Authentication and authorization

- `POST /users/login` and `POST /users/register` are public and rate limited
- Other `/users` routes require `Authorization: Bearer <token>`
- An administrator token lasts 24 hours. A regular token lasts for the account's `sessionTimeout` minutes
- `mustChangePassword` blocks every protected route except `PUT /users/change-password`
- A missing user, or a `tokenVersion` that does not match the token, is rejected
- Administrator routes use `requireAdmin`. Disconnect allows the account owner or an administrator
- Passwords are stored as bcrypt hashes and are omitted from responses

Sign-in does not use a server session cookie. Session length lives on the user document.

## HTTP surface

| Method | Path | Access |
|---|---|---|
| `GET` | `/health` | Public. `{ "ok": true }` and HTTP 200 when MongoDB is connected, otherwise HTTP 503 |
| `POST` | `/users/login` | Public, rate limited |
| `POST` | `/users/register` | Public, rate limited demo registration |
| `PUT` | `/users/change-password` | Signed-in user who must replace a temporary password |
| `GET` | `/users/` | Administrator |
| `POST` | `/users/add` | Administrator |
| `PUT` | `/users/edit` | Administrator |
| `DELETE` | `/users/delete` | Administrator |
| `PUT` | `/users/disconnect` | The signed-in user, or an administrator |

## MongoDB

The user collection stores the credential and the profile together: `username`, password hash, `mustChangePassword`, `tokenVersion`, `firstName`, `lastName`, `permissions`, `sessionTimeout`, and `createAt`.

A locked account is `sessionTimeout <= 0`. There is no separate lock flag. Disconnect cannot raise the stored timeout.

`GET /health` reports only whether the connection is ready. It does not return credentials or the database URI.

## Environment

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Required | Notes |
|---|---|---|
| `SECRET_KEY` | Yes | Must match the catalog API |
| `MONGOOSE_URI` | Yes | Same database as the catalog API |
| `ORIGIN` | Yes | One frontend origin, or a comma-separated list. Production includes `https://cinemahub-xi3w.onrender.com` and `https://movies-jps0.onrender.com` |
| `PORT` | No | Defaults to `3000`. Render provides this value |
| `TRUST_PROXY_HOPS` | On Render | Set to `1` behind one Render proxy hop |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | For welcome email | The account is still created if email fails |
| `SMTP_SECURE` | No | `true` for port 465, otherwise `false` |
| `MAIL_FROM` | No | Visible From address |
| `SMTP_DEBUG` | No | `1` prints SMTP conversation details |

Nodemailer 10 requires Node.js 20 or newer.

## Local development

```bash
npm install
npm run dev
```

`npm start` runs `node server.js`. `npm test` runs the Node test suite against an in-memory database. The tests do not use the database named in `.env`.

The suite covers sign-in, registration, password change, token rejection, user administration, session lock and restore, health, and shutdown.

## Deployment

The Render web service is **Movies-User-Backend**. Build with `npm install` and start with `npm start`. The process listens on `0.0.0.0` and the platform `PORT`. The plan is the free instance in Frankfurt.

Set `SECRET_KEY`, `MONGOOSE_URI`, `ORIGIN`, `NODE_VERSION=20`, and `TRUST_PROXY_HOPS=1` in the Render environment. Add the SMTP variables when welcome email should send. Render supplies `PORT`.

`GET /health` is the health check path. Use Node.js 20 or newer.

The free instance sleeps after a period without traffic. The first request after sleep waits for a new process to start.

## Local JSON

`repositories/users.json` and `repositories/permissions.json` are local files ignored by Git. They are not part of request handling.

`repositories/examples/` contains fictional sample records. `scripts/migrateUserProfiles.js` can copy a JSON snapshot into MongoDB. It refuses a remote database unless that run is explicitly authorized. Starting the server does not run the script.

## Related repositories

| Service | Local URL | Repository |
|---|---|---|
| Interface | Vite dev server | [Movies](https://github.com/maornetzer9/Movies) |
| This API | `http://localhost:3000` | [Movies-User-Backend](https://github.com/maornetzer9/Movies-User-Backend) |
| Movies and subscriptions | `http://localhost:3001` | [Movies-Subscription-Backend](https://github.com/maornetzer9/Movies-Subscription-Backend) |
