const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const TEST_SECRET = 'phase5-cinema-test-secret';
const ADMIN_PASSWORD = 'admin-test-pass';
const USER_PASSWORD = 'user-test-pass';

function assertIsolatedUri(uri) {
    if (!uri || /mongodb\+srv|mongodb\.net|render\.com/i.test(uri)) {
        throw new Error('Refusing to run tests against a non-local database');
    }
    const host = new URL(uri).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
        throw new Error(`Refusing database host ${host}`);
    }
}

describe('cinema-ws integration', () => {
    let mongod;
    let server;
    let base;
    let tempDir;
    let mongoose;
    let User;
    let memoryUri;
    let createApp;

    const readJson = (fileName) =>
        JSON.parse(fs.readFileSync(path.join(tempDir, fileName), 'utf8'));

    const writeJson = (fileName, data) => {
        fs.writeFileSync(path.join(tempDir, fileName), JSON.stringify(data, null, 2));
    };

    async function request(method, pathname, { body, token, headers } = {}) {
        const response = await fetch(`${base}${pathname}`, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }
        return { status: response.status, data, headers: response.headers };
    }

    async function createRegularUser({
        username,
        password = USER_PASSWORD,
        sessionTimeout = 30,
        permissions = ['View-Movies', 'View-Subscriptions'],
        mustChangePassword = false,
        firstName = 'Test',
        lastName = 'User',
    }) {
        return User.create({
            username,
            password,
            mustChangePassword,
            firstName,
            lastName,
            sessionTimeout,
            createAt: '1/1/2026',
            permissions,
        });
    }

    before(async () => {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        mongod = await MongoMemoryServer.create();
        memoryUri = mongod.getUri();
        assertIsolatedUri(memoryUri);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinemahub-users-'));
        writeJson('users.json', []);
        writeJson('permissions.json', []);

        process.env.MONGOOSE_URI = memoryUri;
        process.env.SECRET_KEY = TEST_SECRET;
        process.env.ORIGIN = 'http://localhost:5173';
        process.env.TRUST_PROXY_HOPS = '1';
        process.env.USERS_JSON_DIR = tempDir;
        process.env.MOCK_MOVIES_URL = 'http://127.0.0.1:9/movies';
        process.env.MOCK_USERS_URL = 'http://127.0.0.1:9/users';

        ({ createApp } = require('../app'));
        if (process.env.MONGOOSE_URI !== memoryUri) {
            throw new Error('Test database URI was replaced during startup');
        }
        mongoose = require('mongoose');
        User = require('../models/User');

        await mongoose.connect(memoryUri);
        assertIsolatedUri(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));

        const app = createApp();
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;

        await User.create({ username: 'Admin', password: ADMIN_PASSWORD });
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        if (mongoose) await mongoose.disconnect();
        if (mongod) await mongod.stop();
        assert.deepEqual(readJson('users.json'), []);
        assert.deepEqual(readJson('permissions.json'), []);
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('rejects a remote database uri before connecting', () => {
        assert.throws(() => assertIsolatedUri('mongodb+srv://example.mongodb.net/prod'));
    });

    it('logs in an admin and a regular user', async () => {
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        assert.equal(admin.status, 200);
        assert.equal(admin.data.code, 200);
        assert.equal(admin.data.user.username, 'Admin');
        assert.equal(admin.data.mustChangePassword, false);
        assert.equal(typeof admin.data.token, 'string');

        await createRegularUser({ username: 'viewer', sessionTimeout: 5 });
        const regular = await request('POST', '/users/login', {
            body: { username: 'viewer', password: USER_PASSWORD },
        });
        assert.equal(regular.status, 200);
        assert.equal(regular.data.code, 200);
        assert.equal(regular.data.user.username, 'viewer');
        assert.deepEqual(regular.data.user.permissions, ['View-Movies', 'View-Subscriptions']);
        const claims = JSON.parse(Buffer.from(regular.data.token.split('.')[1], 'base64url'));
        assert.equal(claims.tokenVersion, 0);
        assert.equal(claims.exp - claims.iat, 5 * 60);
    });

    it('rejects invalid credentials without issuing a token', async () => {
        const unknown = await request('POST', '/users/login', {
            body: { username: 'missing-user', password: USER_PASSWORD },
        });
        assert.equal(unknown.status, 200);
        assert.equal(unknown.data.code, 1);
        assert.equal(unknown.data.token, undefined);

        const wrong = await request('POST', '/users/login', {
            body: { username: 'Admin', password: 'not-the-password' },
        });
        assert.equal(wrong.status, 200);
        assert.equal(wrong.data.code, 401);
        assert.equal(wrong.data.token, undefined);
    });

    it('rejects missing, invalid, and expired tokens', async () => {
        const missing = await request('GET', '/users/');
        assert.equal(missing.status, 401);
        assert.equal(missing.data.code, 401);

        const invalid = await request('GET', '/users/', { token: 'not-a-jwt' });
        assert.equal(invalid.status, 401);
        assert.equal(invalid.data.code, 401);

        const jwt = require('jsonwebtoken');
        const expired = jwt.sign(
            { username: 'Admin', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) - 10 },
            TEST_SECRET
        );
        const expiredResponse = await request('GET', '/users/', { token: expired });
        assert.equal(expiredResponse.status, 401);
        assert.equal(expiredResponse.data.code, 401);
    });

    it('rejects a token that has no tokenVersion', async () => {
        const jwt = require('jsonwebtoken');
        const legacy = jwt.sign({ username: 'Admin' }, TEST_SECRET);
        const response = await request('GET', '/users/', { token: legacy });
        assert.equal(response.status, 401);
        assert.equal(response.data.code, 401);
    });

    it('registers a view-only user with a Mongo profile', async () => {
        const response = await request('POST', '/users/register', {
            body: { username: 'RegUser', password: 'register-pass' },
        });
        assert.equal(response.status, 200);
        assert.equal(response.data.code, 200);

        const mongoUser = await User.findOne({ username: 'reguser' });
        assert.ok(mongoUser);
        assert.equal(mongoUser.tokenVersion, 0);
        assert.equal(mongoUser.firstName, 'Demo');
        assert.equal(mongoUser.sessionTimeout, 60);
        assert.deepEqual([...mongoUser.permissions], ['View-Movies', 'View-Subscriptions']);

        const login = await request('POST', '/users/login', {
            body: { username: 'reguser', password: 'register-pass' },
        });
        assert.equal(login.data.code, 200);
        const forbidden = await request('GET', '/users/', { token: login.data.token });
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.data.code, 403);
    });

    it('allows the admin user list and keeps an unrelated profile unchanged', async () => {
        await createRegularUser({ username: 'keeper', firstName: 'Keep', lastName: 'Er' });
        await createRegularUser({ username: 'edited', firstName: 'Edit', lastName: 'Me' });
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        const listed = await request('GET', '/users/', { token: admin.data.token });
        assert.equal(listed.status, 200);
        assert.equal(listed.data.code, 200);
        assert.ok(listed.data.users.some((user) => user.username === 'keeper'));

        const edited = listed.data.users.find((user) => user.username === 'edited');
        const update = await request('PUT', '/users/edit', {
            token: admin.data.token,
            body: {
                _id: edited._id,
                firstName: 'Edited',
                lastName: 'Name',
                username: 'edited',
                sessionTimeout: 12,
                permissions: ['View-Subscriptions'],
            },
        });
        assert.equal(update.status, 200);
        assert.equal(update.data.code, 200);

        const editedProfile = await User.findById(edited._id);
        const keptProfile = await User.findOne({ username: 'keeper' });
        assert.equal(editedProfile.createAt, '1/1/2026');
        assert.equal(editedProfile.sessionTimeout, 12);
        assert.deepEqual([...editedProfile.permissions], ['View-Subscriptions']);
        assert.equal(keptProfile.firstName, 'Keep');
        const mongoUser = editedProfile;
        assert.equal(mongoUser.tokenVersion, 1);

        const oldLogin = await request('POST', '/users/login', {
            body: { username: 'edited', password: USER_PASSWORD },
        });
        const stale = JSON.parse(Buffer.from(oldLogin.data.token.split('.')[1], 'base64url'));
        assert.equal(stale.tokenVersion, 1);
        assert.deepEqual(stale.permissions, ['View-Subscriptions']);

        const jwt = require('jsonwebtoken');
        const previous = jwt.sign(
            { _id: String(edited._id), permissions: ['View-Movies'], tokenVersion: 0 },
            TEST_SECRET
        );
        const revoked = await request('PUT', '/users/disconnect', {
            token: previous,
            body: { user: { _id: String(edited._id), sessionTimeout: 1 } },
        });
        assert.equal(revoked.status, 401);
        assert.equal((await User.findById(edited._id)).sessionTimeout, 12);
    });

    it('locks a session through disconnect and lets an admin restore it', async () => {
        const user = await createRegularUser({ username: 'sessionuser', sessionTimeout: 9 });
        const id = String(user._id);
        const login = await request('POST', '/users/login', {
            body: { username: 'sessionuser', password: USER_PASSWORD },
        });
        assert.equal(login.data.code, 200);
        const claims = JSON.parse(Buffer.from(login.data.token.split('.')[1], 'base64url'));
        assert.equal(claims.exp - claims.iat, 9 * 60);

        const raised = await request('PUT', '/users/disconnect', {
            token: login.data.token,
            body: { user: { _id: id, sessionTimeout: 10 } },
        });
        assert.equal(raised.status, 200);
        assert.equal(raised.data.code, 400);
        assert.equal((await User.findById(id)).sessionTimeout, 9);

        const lowered = await request('PUT', '/users/disconnect', {
            token: login.data.token,
            body: { user: { _id: id, sessionTimeout: 4 } },
        });
        assert.equal(lowered.data.code, 200);
        assert.equal(lowered.data.user.sessionTimeout, 4);
        assert.equal((await User.findById(id)).sessionTimeout, 4);

        const fresh = await request('POST', '/users/login', {
            body: { username: 'sessionuser', password: USER_PASSWORD },
        });
        const locked = await request('PUT', '/users/disconnect', {
            token: fresh.data.token,
            body: { user: { _id: id, sessionTimeout: 0 } },
        });
        assert.equal(locked.data.code, 200);
        assert.equal((await User.findById(id)).sessionTimeout, 0);

        const rejected = await request('POST', '/users/login', {
            body: { username: 'sessionuser', password: USER_PASSWORD },
        });
        assert.equal(rejected.status, 200);
        assert.equal(rejected.data.code, 3);
        assert.equal(rejected.data.token, undefined);

        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        const restored = await request('PUT', '/users/edit', {
            token: admin.data.token,
            body: {
                _id: id,
                firstName: 'Test',
                lastName: 'User',
                username: 'sessionuser',
                sessionTimeout: 6,
                permissions: ['View-Movies', 'View-Subscriptions'],
            },
        });
        assert.equal(restored.data.code, 200);
        assert.equal((await User.findById(id)).sessionTimeout, 6);

        const again = await request('POST', '/users/login', {
            body: { username: 'sessionuser', password: USER_PASSWORD },
        });
        assert.equal(again.data.code, 200);
        const restoredClaims = JSON.parse(Buffer.from(again.data.token.split('.')[1], 'base64url'));
        assert.equal(restoredClaims.exp - restoredClaims.iat, 6 * 60);
    });

    it('requires a password change and invalidates the previous token', async () => {
        const user = await createRegularUser({
            username: 'tempuser',
            mustChangePassword: true,
            sessionTimeout: 15,
        });
        const id = String(user._id);
        const login = await request('POST', '/users/login', {
            body: { username: 'tempuser', password: USER_PASSWORD },
        });
        assert.equal(login.data.code, 200);
        assert.equal(login.data.mustChangePassword, true);

        const blocked = await request('PUT', '/users/disconnect', {
            token: login.data.token,
            body: { user: { _id: id, sessionTimeout: 1 } },
        });
        assert.equal(blocked.status, 403);
        assert.equal(blocked.data.code, 403);
        assert.equal((await User.findById(id)).sessionTimeout, 15);

        const changed = await request('PUT', '/users/change-password', {
            token: login.data.token,
            body: { newPassword: 'changed-pass' },
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.data.code, 200);
        assert.equal(typeof changed.data.token, 'string');
        const mongoUser = await User.findById(id);
        assert.equal(mongoUser.mustChangePassword, false);
        assert.equal(mongoUser.tokenVersion, 1);

        const stale = await request('PUT', '/users/disconnect', {
            token: login.data.token,
            body: { user: { _id: id, sessionTimeout: 1 } },
        });
        assert.equal(stale.status, 401);

        const oldPassword = await request('POST', '/users/login', {
            body: { username: 'tempuser', password: USER_PASSWORD },
        });
        assert.equal(oldPassword.data.code, 401);

        const nextLogin = await request('POST', '/users/login', {
            body: { username: 'tempuser', password: 'changed-pass' },
        });
        assert.equal(nextLogin.data.code, 200);
        assert.equal(nextLogin.data.mustChangePassword, false);
    });

    it('rejects a deleted user token and removes only that backup record', async () => {
        const keep = await createRegularUser({ username: 'keepuser', firstName: 'Stay', lastName: 'Put' });
        const victim = await createRegularUser({ username: 'victim', firstName: 'Go', lastName: 'Away' });
        const login = await request('POST', '/users/login', {
            body: { username: 'victim', password: USER_PASSWORD },
        });
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        const removed = await request('DELETE', `/users/delete?_id=${victim._id}`, {
            token: admin.data.token,
        });
        assert.equal(removed.status, 200);
        assert.equal(removed.data.code, 200);
        assert.equal(await User.findById(victim._id), null);
        const kept = await User.findOne({ username: 'keepuser' });
        assert.equal(kept !== null, true);
        assert.equal(kept.firstName, 'Stay');
        assert.deepEqual([...kept.permissions], ['View-Movies', 'View-Subscriptions']);

        const reused = await request('PUT', '/users/disconnect', {
            token: login.data.token,
            body: { user: { _id: String(victim._id), sessionTimeout: 0 } },
        });
        assert.equal(reused.status, 401);
    });

    it('counts forwarded clients separately when trust proxy is one hop', async () => {
        const send = (forwardedFor) => request('POST', '/users/login', {
            body: { username: 'rate-check', password: 'not-a-password' },
            headers: { 'x-forwarded-for': forwardedFor },
        });
        const first = await send('203.0.113.10');
        const other = await send('203.0.113.20');
        const second = await send('203.0.113.10');
        const remaining = (response) => Number(response.headers.get('ratelimit-remaining'));
        assert.equal(remaining(first), remaining(other));
        assert.equal(remaining(second), remaining(first) - 1);
    });

    it('reports health without authentication and without sensitive fields', async () => {
        const health = await request('GET', '/health');
        assert.equal(health.status, 200);
        assert.deepEqual(health.data, { ok: true });
        assert.doesNotMatch(JSON.stringify(health.data), /mongodb|password|secret|credential|uri/i);

        const users = await request('GET', '/users/');
        assert.equal(users.status, 401);

        await mongoose.disconnect();
        const unavailable = await request('GET', '/health');
        assert.equal(unavailable.status, 503);
        assert.deepEqual(unavailable.data, { ok: false });
        await mongoose.connect(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));
        const restored = await request('GET', '/health');
        assert.equal(restored.status, 200);
        assert.deepEqual(restored.data, { ok: true });
    });

    it('keeps the user after the memory database reconnects', async () => {
        await mongoose.disconnect();
        await mongoose.connect(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));
        const admin = await User.findOne({ username: 'Admin' });
        assert.equal(admin.username, 'Admin');
        const registered = await User.findOne({ username: 'reguser' });
        assert.equal(registered.sessionTimeout, 60);
        assert.deepEqual([...registered.permissions], ['View-Movies', 'View-Subscriptions']);
    });

    async function stopIsolatedServer(signal) {
        const port = await new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.listen(0, '127.0.0.1', () => {
                const reserved = probe.address().port;
                probe.close((err) => (err ? reject(err) : resolve(reserved)));
            });
        });
        const child = spawn(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                PORT: String(port),
                MONGOOSE_URI: memoryUri,
                SECRET_KEY: TEST_SECRET,
                ORIGIN: 'http://localhost:5173',
                USERS_JSON_DIR: tempDir,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });

        try {
            const started = Date.now();
            while (!output.includes(`Server is running on PORT: ${port}`)) {
                if (child.exitCode !== null) throw new Error(output.slice(-800));
                if (Date.now() - started > 20000) throw new Error(`startup timeout: ${output.slice(-800)}`);
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.doesNotMatch(output, /mongodb\+srv|mongodb\.net/i);
            const health = await fetch(`http://127.0.0.1:${port}/health`);
            const body = await health.json();
            assert.equal(health.status, 200);
            assert.deepEqual(body, { ok: true });

            child.send(signal);
            const exitCode = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    reject(new Error(`${signal} shutdown timed out: ${output.slice(-800)}`));
                }, 15000);
                child.once('exit', (code) => {
                    clearTimeout(timer);
                    resolve(code);
                });
            });
            assert.equal(exitCode, 0, output.slice(-800));
            assert.match(output, /Shutting down/);
            await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
            assert.doesNotMatch(output, /mongodb\+srv|mongodb\.net/i);
        } finally {
            if (child.exitCode === null) child.kill('SIGKILL');
        }
    }

    it('hides internal failures and keeps validation messages', async () => {
        const shortPassword = await request('POST', '/users/register', {
            body: { username: 'short-user', password: '123' },
        });
        assert.equal(shortPassword.status, 200);
        assert.equal(shortPassword.data.code, 400);
        assert.equal(shortPassword.data.message, 'Password must be at least 6 characters.');

        const duplicate = await request('POST', '/users/register', {
            body: { username: 'RegUser', password: 'register-pass' },
        });
        assert.equal(duplicate.status, 200);
        assert.equal(duplicate.data.code, 2);
        assert.equal(duplicate.data.message, 'Username already taken');
        assert.equal(duplicate.data.error, undefined);

        const wrongPassword = await request('POST', '/users/login', {
            body: { username: 'Admin', password: 'not-the-password' },
        });
        assert.equal(wrongPassword.status, 200);
        assert.equal(wrongPassword.data.code, 401);
        assert.equal(wrongPassword.data.message, 'Unauthorized');
        assert.equal(JSON.stringify(wrongPassword.data).includes('not-the-password'), false);

        const jwt = require('jsonwebtoken');
        const adminToken = jwt.sign({ username: 'Admin', tokenVersion: 0 }, TEST_SECRET);
        const invalidId = await request('DELETE', '/users/delete?_id=not-an-id', { token: adminToken });
        assert.equal(invalidId.status, 200);
        assert.equal(invalidId.data.code, 5);
        assert.equal(invalidId.data.message, 'User already deleted or does not exist"');
        assert.equal(invalidId.data.error, undefined);
        assert.doesNotMatch(JSON.stringify(invalidId.data), /cast|mongodb|stack|users\.json|secret/i);
        assert.equal(await User.findOne({ username: 'Admin' }) !== null, true);

        const blocker = path.join(tempDir, 'not-a-directory');
        fs.writeFileSync(blocker, 'x');
        const previousDir = process.env.USERS_JSON_DIR;
        process.env.USERS_JSON_DIR = blocker;
        try {
            const { writeUsersFile } = require('../utils/fileHandler');
            const writeFailure = await writeUsersFile('users.json', []);
            assert.equal(writeFailure.code, 500);
            assert.equal(writeFailure.message, 'An error occurred while handling the file');
            assert.doesNotMatch(JSON.stringify(writeFailure), /not-a-directory|ENOENT|ENOTDIR|mongodb|stack/i);

            const registered = await request('POST', '/users/register', {
                body: { username: 'FileFailUser', password: 'register-pass' },
            });
            assert.equal(registered.status, 200);
            assert.equal(registered.data.code, 200);
            assert.equal(registered.data.error, undefined);
            assert.doesNotMatch(JSON.stringify(registered.data), /not-a-directory|ENOENT|ENOTDIR|mongodb|stack|users\.json/i);
            const stored = await User.findOne({ username: 'filefailuser' });
            assert.equal(stored.sessionTimeout, 60);
            assert.deepEqual([...stored.permissions], ['View-Movies', 'View-Subscriptions']);
        } finally {
            process.env.USERS_JSON_DIR = previousDir;
        }
        await User.deleteOne({ username: 'filefailuser' });

        const malformed = await fetch(`${base}/users/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
        });
        const malformedBody = await malformed.json();
        assert.equal(malformed.status, 500);
        assert.deepEqual(malformedBody, { code: 500, message: 'Internal Server Error' });

        await mongoose.disconnect();
        const databaseDown = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        assert.equal(databaseDown.status, 200);
        assert.equal(databaseDown.data.code, 500);
        assert.equal(databaseDown.data.message, 'Internal Server Error');
        assert.equal(databaseDown.data.token, undefined);
        assert.doesNotMatch(JSON.stringify(databaseDown.data), /mongo|127\.0\.0\.1|stack|password/i);
        await mongoose.connect(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));

        const restored = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        assert.equal(restored.status, 200);
        assert.equal(restored.data.code, 200);
        assert.equal(typeof restored.data.token, 'string');
    });

    it('rejects malformed user ids and still deletes a real user', async () => {
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        const token = admin.data.token;
        const target = await createRegularUser({ username: 'idtarget', firstName: 'Id', lastName: 'Target' });
        const targetId = String(target._id);
        const beforeCount = await User.countDocuments();

        const cases = [
            ['DELETE', '/users/delete?_id=', null],
            ['DELETE', '/users/delete?_id[$ne]=', null],
            ['DELETE', '/users/delete?_id=12345', null],
            ['PUT', '/users/edit', { _id: null, firstName: 'X', lastName: 'Y', username: 'idtarget', sessionTimeout: 4, permissions: ['View-Movies'] }],
            ['PUT', '/users/edit', { _id: { $ne: null }, firstName: 'X', lastName: 'Y', username: 'idtarget', sessionTimeout: 4, permissions: ['View-Movies'] }],
            ['PUT', '/users/edit', { _id: [targetId], firstName: 'X', lastName: 'Y', username: 'idtarget', sessionTimeout: 4, permissions: ['View-Movies'] }],
            ['PUT', '/users/edit', { _id: 12345, firstName: 'X', lastName: 'Y', username: 'idtarget', sessionTimeout: 4, permissions: ['View-Movies'] }],
            ['PUT', '/users/disconnect', { user: { _id: { $gt: '' }, sessionTimeout: 0 } }],
        ];

        for (const [method, pathname, body] of cases) {
            const response = await request(method, pathname, body === null ? { token } : { token, body });
            assert.equal(response.status, 200);
            assert.notEqual(response.data.code, 200);
            assert.doesNotMatch(JSON.stringify(response.data), /\$ne|\$gt|cast|mongodb|stack/i);
        }

        assert.equal(await User.countDocuments(), beforeCount);
        assert.equal((await User.findById(targetId)).username, 'idtarget');
        assert.equal((await User.findById(targetId)).firstName, 'Id');

        const removed = await request('DELETE', `/users/delete?_id=${targetId}`, { token });
        assert.equal(removed.status, 200);
        assert.equal(removed.data.code, 200);
        assert.equal(await User.findById(targetId), null);
        assert.equal(await User.findOne({ username: 'Admin' }) !== null, true);
        assert.equal(await User.findOne({ username: 'keeper' }) !== null, true);
    });

    function assertNoSecrets(payload) {
        const json = JSON.stringify(payload);
        assert.equal(json.includes('"password"'), false);
        assert.equal(json.includes('temporaryPassword'), false);
        assert.doesNotMatch(json, /\$2[aby]\$\d{2}\$/);
    }

    it('omits password hashes from user responses', async () => {
        const adminLogin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        assert.equal(adminLogin.status, 200);
        assert.equal(adminLogin.data.code, 200);
        assert.equal(adminLogin.data.user.username, 'Admin');
        assert.equal(typeof adminLogin.data.token, 'string');
        assert.equal(adminLogin.data.mustChangePassword, false);
        assertNoSecrets(adminLogin.data);

        const listed = await request('GET', '/users/', { token: adminLogin.data.token });
        assert.equal(listed.status, 200);
        assert.equal(listed.data.code, 200);
        assert.ok(listed.data.users.some((user) => user.username === 'keeper'));
        assertNoSecrets(listed.data);

        const registered = await request('POST', '/users/register', {
            body: { username: 'SecretReg', password: 'register-pass' },
        });
        assert.equal(registered.status, 200);
        assert.equal(registered.data.code, 200);
        assertNoSecrets(registered.data);

        const created = await createRegularUser({
            username: 'secretuser',
            firstName: 'Secret',
            lastName: 'User',
            mustChangePassword: true,
            sessionTimeout: 20,
        });
        const id = String(created._id);
        const stored = await User.findById(id).select('+password');
        assert.match(stored.password, /^\$2[aby]\$/);

        const login = await request('POST', '/users/login', {
            body: { username: 'secretuser', password: USER_PASSWORD },
        });
        assert.equal(login.data.code, 200);
        assert.equal(login.data.mustChangePassword, true);
        assert.equal(login.data.user.username, 'secretuser');
        assert.equal(login.data.user.sessionTimeout, 20);
        assert.equal(typeof login.data.token, 'string');
        assertNoSecrets(login.data);

        const changed = await request('PUT', '/users/change-password', {
            token: login.data.token,
            body: { newPassword: 'changed-secret' },
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.data.code, 200);
        assert.equal(typeof changed.data.token, 'string');
        assertNoSecrets(changed.data);
        const nextLogin = await request('POST', '/users/login', {
            body: { username: 'secretuser', password: 'changed-secret' },
        });
        assert.equal(nextLogin.data.code, 200);
        assert.equal(nextLogin.data.mustChangePassword, false);
        assertNoSecrets(nextLogin.data);

        const edited = await request('PUT', '/users/edit', {
            token: adminLogin.data.token,
            body: {
                _id: id,
                firstName: 'Hidden',
                lastName: 'Hash',
                username: 'secretuser',
                sessionTimeout: 20,
                permissions: ['View-Movies'],
            },
        });
        assert.equal(edited.status, 200);
        assert.equal(edited.data.code, 200);
        assert.equal(edited.data.user.username, 'secretuser');
        assert.equal(edited.data.user.firstName, 'Hidden');
        assertNoSecrets(edited.data);

        const removed = await request('DELETE', `/users/delete?_id=${id}`, { token: adminLogin.data.token });
        assert.equal(removed.status, 200);
        assert.equal(removed.data.code, 200);
        assert.equal(removed.data.users.some((user) => user.username === 'secretuser'), false);
        assert.equal(removed.data.users.some((user) => user.username === 'keeper'), true);
        assertNoSecrets(removed.data);
        assert.equal(await User.findById(id), null);
    });

    it('rejects operator payloads for username fields', async () => {
        const shapes = [
            { $ne: null },
            { $gt: '' },
            { $regex: '.*' },
            ['Admin'],
            null,
            1,
            { nested: { $ne: null } },
        ];
        const before = await User.countDocuments();
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        assert.equal(admin.data.code, 200);

        for (const username of shapes) {
            const login = await request('POST', '/users/login', {
                body: { username, password: ADMIN_PASSWORD },
            });
            assert.equal(login.status, 200);
            assert.equal(login.data.code, 400);
            assert.equal(login.data.token, undefined);

            const registered = await request('POST', '/users/register', {
                body: { username, password: 'register-pass' },
            });
            assert.equal(registered.status, 200);
            assert.equal(registered.data.code, 400);
            assert.equal(registered.data.token, undefined);

            const created = await request('POST', '/users/add', {
                token: admin.data.token,
                body: {
                    firstName: 'Bad',
                    lastName: 'User',
                    username,
                    sessionTimeout: 10,
                    permissions: ['View-Movies'],
                    email: 'bad-user@example.test',
                },
            });
            assert.equal(created.status, 200);
            assert.equal(created.data.code, 400);

            const edited = await request('PUT', '/users/edit', {
                token: admin.data.token,
                body: {
                    _id: String((await User.findOne({ username: 'keeper' }))._id),
                    firstName: 'Keep',
                    lastName: 'Er',
                    username,
                    sessionTimeout: 30,
                    permissions: ['View-Movies', 'View-Subscriptions'],
                },
            });
            assert.equal(edited.status, 200);
            assert.equal(edited.data.code, 400);
        }

        assert.equal(await User.countDocuments(), before);
        assert.equal((await User.findOne({ username: 'keeper' })).username, 'keeper');
        assert.equal((await User.findOne({ username: 'Admin' })).username, 'Admin');

        const legitimate = await request('POST', '/users/register', {
            body: { username: 'ScalarUser', password: 'register-pass' },
        });
        assert.equal(legitimate.data.code, 200);
        const login = await request('POST', '/users/login', {
            body: { username: 'scalaruser', password: 'register-pass' },
        });
        assert.equal(login.data.code, 200);
        assert.equal(login.data.user.username, 'scalaruser');
        assert.deepEqual(login.data.user.permissions, ['View-Movies', 'View-Subscriptions']);
    });

    it('omits unexpected fields stored beside a profile', async () => {
        const created = await createRegularUser({
            username: 'profileuser',
            firstName: 'Pat',
            lastName: 'Lee',
            sessionTimeout: 11,
        });
        const id = String(created._id);
        await User.collection.updateOne(
            { _id: created._id },
            { $set: { secret: 'token-should-not-leak', apiKey: 'should-not-leak' } }
        );

        const login = await request('POST', '/users/login', {
            body: { username: 'profileuser', password: USER_PASSWORD },
        });
        assert.equal(login.data.code, 200);
        assert.equal(login.data.user._id, id);
        assert.equal(login.data.user.firstName, 'Pat');
        assert.equal(login.data.user.lastName, 'Lee');
        assert.equal(login.data.user.sessionTimeout, 11);
        assert.equal(login.data.user.createAt, '1/1/2026');
        assert.equal(login.data.user.username, 'profileuser');
        assert.deepEqual(login.data.user.permissions, ['View-Movies', 'View-Subscriptions']);
        assert.equal(login.data.user.password, undefined);
        assert.equal(login.data.user.temporaryPassword, undefined);
        assert.equal(login.data.user.secret, undefined);
        assert.equal(login.data.user.apiKey, undefined);

        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        const listed = await request('GET', '/users/', { token: admin.data.token });
        const listedUser = listed.data.users.find((user) => user.username === 'profileuser');
        assert.equal(listedUser.firstName, 'Pat');
        assert.equal(listedUser.createAt, '1/1/2026');
        assert.deepEqual(listedUser.permissions, ['View-Movies', 'View-Subscriptions']);
        assert.equal(listedUser.secret, undefined);
        assert.equal(listedUser.password, undefined);
        assert.equal(listedUser.apiKey, undefined);

        const disconnected = await request('PUT', '/users/disconnect', {
            token: login.data.token,
            body: { user: { _id: id, sessionTimeout: 11 } },
        });
        assert.equal(disconnected.data.code, 200);
        assert.equal(disconnected.data.user.sessionTimeout, 11);
        assert.equal(disconnected.data.user.firstName, 'Pat');
        assert.equal(disconnected.data.user.secret, undefined);
        const raw = await User.collection.findOne({ _id: created._id });
        assert.equal(raw.secret, 'token-should-not-leak');
        assert.equal(raw.apiKey, 'should-not-leak');
        assert.equal(raw.sessionTimeout, 11);
    });

    it('shuts down on SIGTERM and closes the listener', async () => {
        await stopIsolatedServer('SIGTERM');
    });

    it('shuts down on SIGINT and closes the listener', async () => {
        await stopIsolatedServer('SIGINT');
    });
});
