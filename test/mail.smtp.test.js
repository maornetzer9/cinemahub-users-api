const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const TEST_SECRET = 'phase98-cinema-mail-secret';
const ADMIN_PASSWORD = 'admin-test-pass';
const MAILBOX = 'mailer@example.test';
const RECIPIENT = 'new-user@example.test';

function assertIsolatedUri(uri) {
    if (!uri || /mongodb\+srv|mongodb\.net|render\.com/i.test(uri)) {
        throw new Error('Refusing to run tests against a non-local database');
    }
    const host = new URL(uri).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
        throw new Error(`Refusing database host ${host}`);
    }
}

function startLocalSmtp() {
    const messages = [];
    const server = net.createServer((socket) => {
        let buffer = '';
        let mode = 'command';
        let data = '';
        socket.write('220 localhost ESMTP test\r\n');
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let newline = buffer.indexOf('\n');
            while (newline !== -1) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                if (mode === 'data') {
                    if (line === '.') {
                        messages.push(data);
                        data = '';
                        mode = 'command';
                        socket.write('250 queued\r\n');
                    } else {
                        data += `${line}\n`;
                    }
                } else if (/^EHLO\b/i.test(line)) {
                    socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
                } else if (/^HELO\b/i.test(line)) {
                    socket.write('250 localhost\r\n');
                } else if (/^AUTH PLAIN\b/i.test(line)) {
                    socket.write('235 accepted\r\n');
                } else if (/^AUTH LOGIN/i.test(line)) {
                    socket.write('334 VXNlcm5hbWU6\r\n');
                } else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) {
                    socket.write('250 OK\r\n');
                } else if (/^DATA\b/i.test(line)) {
                    mode = 'data';
                    socket.write('354 send the message\r\n');
                } else if (/^QUIT\b/i.test(line)) {
                    socket.write('221 bye\r\n');
                    socket.end();
                } else if (/^RSET\b/i.test(line) || /^NOOP\b/i.test(line)) {
                    socket.write('250 OK\r\n');
                } else if (mode === 'command' && line.length > 0) {
                    socket.write('235 accepted\r\n');
                }
                newline = buffer.indexOf('\n');
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                server,
                port: server.address().port,
                messages,
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}

function messageParts(raw) {
    const normalized = raw.replace(/\r\n/g, '\n');
    const splitAt = normalized.indexOf('\n\n');
    const headers = splitAt === -1 ? normalized : normalized.slice(0, splitAt);
    const body = splitAt === -1 ? '' : normalized.slice(splitAt + 2);
    const headerValue = (name) => {
        const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
        return match ? match[1].trim() : '';
    };
    return { headers, body, headerValue };
}

describe('cinema-ws local SMTP onboarding', () => {
    let mongod;
    let server;
    let smtp;
    let base;
    let tempDir;
    let mongoose;
    let User;
    let createApp;

    async function request(method, pathname, { body, token } = {}) {
        const response = await fetch(`${base}${pathname}`, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }
        return { status: response.status, data };
    }

    before(async () => {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        mongod = await MongoMemoryServer.create();
        const memoryUri = mongod.getUri();
        assertIsolatedUri(memoryUri);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinemahub-mail-'));
        fs.writeFileSync(path.join(tempDir, 'users.json'), '[]');
        fs.writeFileSync(path.join(tempDir, 'permissions.json'), '[]');

        smtp = await startLocalSmtp();
        process.env.MONGOOSE_URI = memoryUri;
        process.env.SECRET_KEY = TEST_SECRET;
        process.env.ORIGIN = 'http://localhost:5173';
        process.env.TRUST_PROXY_HOPS = '1';
        process.env.USERS_JSON_DIR = tempDir;
        process.env.SMTP_HOST = '127.0.0.1';
        process.env.SMTP_PORT = String(smtp.port);
        process.env.SMTP_USER = MAILBOX;
        process.env.SMTP_PASS = 'local-only-secret';
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_DEBUG = '0';
        process.env.MAIL_FROM = MAILBOX;

        ({ createApp } = require('../app'));
        mongoose = require('mongoose');
        User = require('../models/User');
        await mongoose.connect(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));

        const app = createApp();
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        await User.create({ username: 'Admin', password: ADMIN_PASSWORD });
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        if (smtp) await smtp.close();
        if (mongoose) await mongoose.disconnect();
        if (mongod) await mongod.stop();
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('sends the onboarding message to the local SMTP server', async () => {
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        assert.equal(admin.data.code, 200);
        const created = await request('POST', '/users/add', {
            token: admin.data.token,
            body: {
                firstName: 'Mail',
                lastName: 'User',
                username: 'mailuser',
                sessionTimeout: 30,
                permissions: ['View-Movies'],
                email: RECIPIENT,
            },
        });
        assert.equal(created.status, 200);
        assert.equal(created.data.code, 200);
        assert.equal(created.data.user.username, 'mailuser');
        assert.equal(created.data.user.firstName, 'Mail');
        assert.equal(JSON.stringify(created.data).includes('Temporary password'), false);
        assert.equal(JSON.stringify(created.data).includes('"password"'), false);

        assert.equal(smtp.messages.length, 1);
        const message = messageParts(smtp.messages[0]);
        assert.match(message.headerValue('To'), new RegExp(RECIPIENT));
        assert.equal(message.headerValue('Subject'), 'Your account and temporary password');
        assert.match(message.body, /Your account has been created/);
        assert.match(message.body, /Username: mailuser/);
        const passwordLine = message.body.match(/Temporary password: ([A-Za-z0-9]{12})/);
        assert.ok(passwordLine);
        assert.match(message.body, /required to change it/);
        assert.equal(JSON.stringify(created.data).includes(passwordLine[1]), false);

        const login = await request('POST', '/users/login', {
            body: { username: 'mailuser', password: passwordLine[1] },
        });
        assert.equal(login.data.code, 200);
        assert.equal(login.data.mustChangePassword, true);
        assert.equal(JSON.stringify(login.data).includes(passwordLine[1]), false);
    });

    it('returns the existing safe response when SMTP delivery fails', async () => {
        await smtp.close();
        smtp = null;
        const admin = await request('POST', '/users/login', {
            body: { username: 'Admin', password: ADMIN_PASSWORD },
        });
        const created = await request('POST', '/users/add', {
            token: admin.data.token,
            body: {
                firstName: 'Fail',
                lastName: 'User',
                username: 'mailfail',
                sessionTimeout: 30,
                permissions: ['View-Movies'],
                email: 'fail-user@example.test',
            },
        });
        assert.equal(created.status, 200);
        assert.equal(created.data.code, 500);
        assert.equal(created.data.message, 'User was created, but the welcome email could not be sent.');
        assert.equal(created.data.user, undefined);
        const body = JSON.stringify(created.data);
        assert.doesNotMatch(body, /ECONNREFUSED|All SMTP|Temporary password|local-only-secret|stack/i);
        const stored = await User.findOne({ username: 'mailfail' });
        assert.ok(stored);
        assert.equal(stored.mustChangePassword, true);
    });
});
