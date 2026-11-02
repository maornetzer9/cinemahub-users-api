const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_PASSWORD = 'migration-test-pass';
const SCRIPT = path.join(__dirname, '../scripts/migrateUserProfiles.js');
const REAL_USERS = path.join(__dirname, '../repositories/users.json');
const REAL_PERMISSIONS = path.join(__dirname, '../repositories/permissions.json');

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertLocalUri(uri) {
    if (!uri || /mongodb\+srv|mongodb\.net|render\.com/i.test(uri)) {
        throw new Error('Refusing to run tests against a non-local database');
    }
    const host = new URL(uri).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
        throw new Error(`Refusing database host ${host}`);
    }
}

function writeFixtures(users, permissions) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinemahub-migrate-'));
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));
    fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify(permissions, null, 2));
    return dir;
}

function profileFor(id, overrides = {}) {
    return {
        _id: id,
        firstName: 'Test',
        lastName: 'Member',
        sessionTimeout: 30,
        createAt: '1/1/2026',
        ...overrides,
    };
}

describe('profile migration', () => {
    let mongod;
    let mongoose;
    let User;
    let migrateUserProfiles;
    let assertLocalMongoTarget;
    let memoryUri;
    let realHashes;
    const tempDirs = [];

    function fixtures(users, permissions = []) {
        const dir = writeFixtures(users, permissions);
        tempDirs.push(dir);
        return dir;
    }

    async function createAccount(username, extra = {}) {
        return User.create({
            username,
            password: TEST_PASSWORD,
            mustChangePassword: false,
            tokenVersion: 0,
            ...extra,
        });
    }

    async function storedAccount(id) {
        return User.findById(id).select('+password username mustChangePassword tokenVersion firstName lastName sessionTimeout createAt permissions');
    }

    before(async () => {
        realHashes = {
            users: hashFile(REAL_USERS),
            permissions: hashFile(REAL_PERMISSIONS),
        };

        const { MongoMemoryServer } = require('mongodb-memory-server');
        mongod = await MongoMemoryServer.create();
        memoryUri = mongod.getUri();
        assertLocalUri(memoryUri);

        process.env.MONGOOSE_URI = memoryUri;
        process.env.SECRET_KEY = 'phase-11-2c-migration-secret';

        mongoose = require('mongoose');
        await mongoose.connect(memoryUri);
        assertLocalUri(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));

        User = require('../models/User');
        ({
            migrateUserProfiles,
            assertLocalMongoTarget,
            assertMigrationTarget,
            parseArgs,
        } = require('../scripts/migrateUserProfiles'));
    });

    beforeEach(async () => {
        await User.deleteMany({});
    });

    after(async () => {
        assert.equal(hashFile(REAL_USERS), realHashes.users);
        assert.equal(hashFile(REAL_PERMISSIONS), realHashes.permissions);
        tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
        if (mongoose) await mongoose.disconnect();
        if (mongod) await mongod.stop();
    });

    it('rejects a remote database uri', () => {
        assert.throws(() => assertLocalMongoTarget('mongodb+srv://example.mongodb.net/prod', null));
    });

    it('copies a matching profile and preserves credentials', async () => {
        const created = await createAccount('member', { mustChangePassword: true, tokenVersion: 4 });
        const id = String(created._id);
        const before = await storedAccount(id);
        const dir = fixtures(
            [profileFor(id, { firstName: 'Current', sessionTimeout: 25 })],
            [{ _id: id, permissions: ['View-Movies', 'Create-Movies'] }]
        );

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, true);
        assert.equal(result.wrote, true);
        assert.equal(result.updates.length, 1);
        assert.equal(after.firstName, 'Current');
        assert.equal(after.lastName, 'Member');
        assert.equal(after.sessionTimeout, 25);
        assert.equal(after.createAt, '1/1/2026');
        assert.deepEqual(after.permissions, ['View-Movies', 'Create-Movies']);
        assert.equal(after.username, 'member');
        assert.equal(after.password, before.password);
        assert.equal(after.mustChangePassword, true);
        assert.equal(after.tokenVersion, 4);
        assert.equal(after.locked, undefined);
    });

    it('reports a json profile with no credential account and does not create one', async () => {
        const missingId = '507f1f77bcf86cd799439011';
        const beforeCount = await User.countDocuments();
        const dir = fixtures(
            [profileFor(missingId)],
            [{ _id: missingId, permissions: ['View-Movies'] }]
        );

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });

        assert.equal(result.ok, true);
        assert.equal(result.wrote, false);
        assert.deepEqual(result.missingAccounts, [{ _id: missingId }]);
        assert.equal(result.updates.length, 0);
        assert.equal(await User.countDocuments(), beforeCount);
        assert.equal(await User.findById(missingId), null);
    });

    it('leaves a credential account unchanged when its json profile is missing', async () => {
        const created = await createAccount('credential-only', { tokenVersion: 2 });
        const id = String(created._id);
        const dir = fixtures([], []);

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, true);
        assert.equal(result.wrote, false);
        assert.deepEqual(result.mongoWithoutProfile, [{ _id: id, username: 'credential-only' }]);
        assert.equal(after.firstName, undefined);
        assert.equal(after.permissions, undefined);
        assert.equal(after.tokenVersion, 2);
        assert.equal(after.password.length > 0, true);
    });

    it('fails duplicate ids without writing', async () => {
        const created = await createAccount('duplicate-member');
        const id = String(created._id);
        const dir = fixtures([profileFor(id), profileFor(id, { firstName: 'Other' })], []);

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.equal(result.updates.length, 0);
        assert.match(result.errors[0], /Duplicate _id in users\.json/);
        assert.equal(after.firstName, undefined);
    });

    it('fails invalid ids without writing valid siblings', async () => {
        const created = await createAccount('valid-member');
        const id = String(created._id);
        const dir = fixtures([
            profileFor(id),
            profileFor('not-an-object-id'),
        ], []);

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.equal(result.updates.length, 0);
        assert.match(result.errors.join('\n'), /Invalid _id in users\.json/);
        assert.equal(after.firstName, undefined);
    });

    it('stores an empty permission list when the permissions row is missing', async () => {
        const created = await createAccount('no-permissions');
        const id = String(created._id);
        const dir = fixtures([profileFor(id)], []);

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, true);
        assert.deepEqual(result.updates[0].permissions, []);
        assert.deepEqual(after.permissions, []);
    });

    it('preserves a locked sessionTimeout of 0', async () => {
        const created = await createAccount('locked-member', { tokenVersion: 6 });
        const id = String(created._id);
        const before = await storedAccount(id);
        const dir = fixtures(
            [profileFor(id, { sessionTimeout: 0 })],
            [{ _id: id, permissions: ['View-Subscriptions'] }]
        );

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, true);
        assert.equal(result.updates[0].locked, true);
        assert.equal(result.updates[0].sessionTimeout, 0);
        assert.equal(after.sessionTimeout, 0);
        assert.equal(after.password, before.password);
        assert.equal(after.tokenVersion, 6);
    });

    it('applies the same source twice without changing credentials', async () => {
        const created = await createAccount('repeat-member', { tokenVersion: 3 });
        const id = String(created._id);
        const dir = fixtures(
            [profileFor(id, { firstName: 'Source' })],
            [{ _id: id, permissions: ['View-Movies'] }]
        );

        const first = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const afterFirst = await storedAccount(id);
        await User.updateOne({ _id: id }, { $set: { firstName: 'Temporary' } });
        const second = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const afterSecond = await storedAccount(id);

        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        assert.equal(afterSecond.firstName, 'Source');
        assert.deepEqual([...afterSecond.permissions], ['View-Movies']);
        assert.equal(afterSecond.password, afterFirst.password);
        assert.equal(afterSecond.tokenVersion, 3);
        assert.equal(afterSecond.username, 'repeat-member');
    });

    it('does not write during a dry run', async () => {
        const created = await createAccount('dry-member', { mustChangePassword: true, tokenVersion: 8 });
        const id = String(created._id);
        const before = await storedAccount(id);
        const source = profileFor(id, { firstName: 'Planned', sessionTimeout: 12 });
        const dir = fixtures([source], [{ _id: id, permissions: ['View-Movies'] }]);
        const usersBefore = fs.readFileSync(path.join(dir, 'users.json'));
        const permissionsBefore = fs.readFileSync(path.join(dir, 'permissions.json'));

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'dry-run' });
        const after = await storedAccount(id);

        assert.equal(result.ok, true);
        assert.equal(result.wrote, false);
        assert.equal(result.applied.length, 0);
        assert.equal(result.updates.length, 1);
        assert.equal(result.updates[0]._id, id);
        assert.equal(result.updates[0].firstName, 'Planned');
        assert.equal(result.updates[0].sessionTimeout, 12);
        assert.deepEqual(result.updates[0].permissions, ['View-Movies']);
        assert.equal(after.firstName, undefined);
        assert.equal(after.password, before.password);
        assert.equal(after.tokenVersion, 8);
        assert.equal(after.mustChangePassword, true);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'users.json')), usersBefore);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'permissions.json')), permissionsBefore);
    });

    it('fails invalid source data without writing', async () => {
        const created = await createAccount('invalid-source');
        const id = String(created._id);
        const dir = fixtures([], []);
        fs.writeFileSync(path.join(dir, 'users.json'), '{"not":"an array"}');

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.equal(result.updates.length, 0);
        assert.match(result.errors[0], /users\.json must be a JSON array/);
        assert.equal(after.firstName, undefined);
    });

    it('refuses a remote uri without writing the planned profile', async () => {
        const created = await createAccount('remote-guard');
        const id = String(created._id);
        const dir = fixtures([profileFor(id)], [{ _id: id, permissions: ['View-Movies'] }]);
        const previousUri = process.env.MONGOOSE_URI;
        process.env.MONGOOSE_URI = 'mongodb+srv://example.mongodb.net/prod';

        try {
            const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
            const after = await storedAccount(id);
            assert.equal(result.ok, false);
            assert.equal(result.wrote, false);
            assert.equal(result.errors[0], 'Refusing to run migration against a remote database');
            assert.equal(result.errors.join('\n').includes('example.mongodb.net'), false);
            assert.equal(after.firstName, undefined);
        } finally {
            process.env.MONGOOSE_URI = previousUri;
        }
    });

    it('requires an explicit mode and refuses a remote uri from the command line', () => {
        const childEnv = {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
        };

        const missingMode = spawnSync(process.execPath, [SCRIPT], {
            cwd: path.join(__dirname, '..'),
            env: { ...childEnv, MONGOOSE_URI: memoryUri },
            encoding: 'utf8',
            timeout: 20000,
        });
        assert.equal(missingMode.status, 1);
        assert.match(missingMode.stderr, /--dry-run or --apply/);

        const remote = spawnSync(process.execPath, [SCRIPT, '--apply'], {
            cwd: path.join(__dirname, '..'),
            env: { ...childEnv, MONGOOSE_URI: 'mongodb+srv://example.mongodb.net/prod' },
            encoding: 'utf8',
            timeout: 20000,
        });
        assert.equal(remote.status, 1);
        assert.match(remote.stderr, /Refusing to run migration against a remote database/);
        assert.equal(remote.stderr.includes('example.mongodb.net'), false);
        assert.equal(remote.stdout.includes('mongodb+srv'), false);
    });

    it('fails malformed json without writing', async () => {
        const created = await createAccount('malformed-source');
        const id = String(created._id);
        const dir = fixtures([profileFor(id)], []);
        fs.writeFileSync(path.join(dir, 'users.json'), '{');

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.equal(result.updates.length, 0);
        assert.match(result.errors[0], /Cannot read users\.json/);
        assert.equal(after.firstName, undefined);
    });

    it('fails duplicate permission ids without writing', async () => {
        const created = await createAccount('duplicate-permissions');
        const id = String(created._id);
        const dir = fixtures(
            [profileFor(id)],
            [
                { _id: id, permissions: ['View-Movies'] },
                { _id: id, permissions: ['View-Subscriptions'] },
            ]
        );

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const after = await storedAccount(id);

        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.errors.join('\n'), /Duplicate _id in permissions\.json/);
        assert.equal(after.firstName, undefined);
    });

    it('does not modify unrelated stored fields', async () => {
        const created = await createAccount('extra-field', { mustChangePassword: true, tokenVersion: 2 });
        const id = String(created._id);
        await User.collection.updateOne({ _id: created._id }, { $set: { city: 'Haifa' } });
        const before = await storedAccount(id);
        const dir = fixtures(
            [profileFor(id, { firstName: 'Kept' })],
            [{ _id: id, permissions: ['View-Movies'] }]
        );

        const result = await migrateUserProfiles({ jsonDir: dir, mode: 'apply' });
        const raw = await User.collection.findOne({ _id: created._id });
        const after = await storedAccount(id);

        assert.equal(result.ok, true);
        assert.equal(after.firstName, 'Kept');
        assert.equal(raw.city, 'Haifa');
        assert.equal(after.username, 'extra-field');
        assert.equal(after.password, before.password);
        assert.equal(after.mustChangePassword, true);
        assert.equal(after.tokenVersion, 2);
    });

    it('requires separate authorization before a remote write', () => {
        const remoteUri = 'mongodb+srv://example.mongodb.net/prod';
        let missingWrite;
        try {
            assertMigrationTarget(remoteUri, null, { allowRemote: true, mode: 'apply' });
        } catch (err) {
            missingWrite = err;
        }
        assert.ok(missingWrite);
        assert.match(missingWrite.message, /without explicit authorization/);
        assert.equal(missingWrite.message.includes('example.mongodb.net'), false);

        assert.doesNotThrow(() => assertMigrationTarget(remoteUri, null, {
            allowRemote: true,
            mode: 'dry-run',
        }));
        assert.doesNotThrow(() => assertMigrationTarget(remoteUri, null, {
            allowRemote: true,
            allowRemoteWrite: true,
            mode: 'apply',
        }));

        const parsed = parseArgs(['--apply', '--authorize-remote', '--authorize-remote-write']);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.allowRemote, true);
        assert.equal(parsed.allowRemoteWrite, true);
        const dryRun = parseArgs(['--dry-run', '--authorize-remote']);
        assert.equal(dryRun.allowRemoteWrite, false);
    });

    it('does not write when remote authorization does not match the connected database', async () => {
        const created = await createAccount('mismatch-member');
        const id = String(created._id);
        const dir = fixtures([profileFor(id, { firstName: 'ShouldNotApply' })], []);
        const previousUri = process.env.MONGOOSE_URI;
        process.env.MONGOOSE_URI = 'mongodb+srv://example.mongodb.net/prod';

        try {
            const result = await migrateUserProfiles({
                jsonDir: dir,
                mode: 'apply',
                allowRemote: true,
                allowRemoteWrite: true,
            });
            const after = await storedAccount(id);

            assert.equal(result.ok, false);
            assert.equal(result.wrote, false);
            assert.match(result.errors[0], /does not match the authorized target/);
            assert.equal(result.errors.join('\n').includes('example.mongodb.net'), false);
            assert.equal(after.firstName, undefined);
        } finally {
            process.env.MONGOOSE_URI = previousUri;
        }
    });

    it('refuses a remote command-line write until both authorization flags are present', () => {
        const childEnv = {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            MONGOOSE_URI: 'mongodb+srv://example.mongodb.net/prod',
        };
        const cwd = path.join(__dirname, '..');

        const writeOnly = spawnSync(process.execPath, [SCRIPT, '--apply', '--authorize-remote-write'], {
            cwd,
            env: childEnv,
            encoding: 'utf8',
            timeout: 20000,
        });
        assert.equal(writeOnly.status, 1);
        assert.match(writeOnly.stderr, /Refusing to run migration against a remote database/);
        assert.equal(writeOnly.stderr.includes('example.mongodb.net'), false);
        assert.equal(writeOnly.stdout.includes('mongodb'), false);

        const connectOnly = spawnSync(process.execPath, [SCRIPT, '--apply', '--authorize-remote'], {
            cwd,
            env: childEnv,
            encoding: 'utf8',
            timeout: 20000,
        });
        assert.equal(connectOnly.status, 1);
        assert.match(connectOnly.stderr, /without explicit authorization/);
        assert.equal(connectOnly.stderr.includes('example.mongodb.net'), false);
        assert.equal(connectOnly.stderr.includes('could not connect'), false);
    });
});
