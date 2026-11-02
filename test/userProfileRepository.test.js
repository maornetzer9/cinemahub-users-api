const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_PASSWORD = 'repository-test-pass';

function assertIsolatedUri(uri) {
    if (!uri || /mongodb\+srv|mongodb\.net|render\.com/i.test(uri)) {
        throw new Error('Refusing to run tests against a non-local database');
    }
    const host = new URL(uri).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
        throw new Error(`Refusing database host ${host}`);
    }
}

describe('user profile repository', () => {
    let mongod;
    let mongoose;
    let User;
    let compareHash;
    let repository;

    const profileInput = {
        firstName: 'Test',
        lastName: 'Member',
        sessionTimeout: 30,
        createAt: '1/1/2026',
        permissions: ['View-Movies', 'View-Subscriptions'],
        password: 'must-not-replace-the-hash',
        username: 'must-not-rename',
        mustChangePassword: true,
        tokenVersion: 9,
    };

    before(async () => {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        mongod = await MongoMemoryServer.create();
        const memoryUri = mongod.getUri();
        assertIsolatedUri(memoryUri);

        process.env.MONGOOSE_URI = memoryUri;
        process.env.SECRET_KEY = 'phase-11-2b-repository-secret';

        mongoose = require('mongoose');
        await mongoose.connect(memoryUri);
        assertIsolatedUri(memoryUri);
        assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host));

        User = require('../models/User');
        ({ compareHash } = require('../utils/bcrypt'));
        repository = require('../repositories/userProfileRepository');
    });

    after(async () => {
        if (mongoose) await mongoose.disconnect();
        if (mongod) await mongod.stop();
    });

    it('rejects a remote database uri before connecting', () => {
        assert.throws(() => assertIsolatedUri('mongodb+srv://example.mongodb.net/prod'));
    });

    it('stores a profile without changing credentials or creating a lock flag', async () => {
        const created = await User.create({
            username: 'member',
            password: TEST_PASSWORD,
            mustChangePassword: true,
            tokenVersion: 2,
        });
        const id = String(created._id);
        assert.equal(created.firstName, undefined);
        assert.equal(created.sessionTimeout, undefined);
        assert.equal(created.permissions, undefined);

        const before = await User.findById(id).select('+password');
        const originalHash = before.password;

        const saved = await repository.saveProfile(id, profileInput);
        assert.equal(saved.ok, true);
        assert.equal(saved.profile._id, id);
        assert.equal(saved.profile.username, 'member');
        assert.equal(saved.profile.firstName, 'Test');
        assert.equal(saved.profile.lastName, 'Member');
        assert.equal(saved.profile.sessionTimeout, 30);
        assert.equal(saved.profile.createAt, '1/1/2026');
        assert.deepEqual(saved.profile.permissions, ['View-Movies', 'View-Subscriptions']);
        assert.equal(saved.profile.password, undefined);
        assert.equal(saved.profile.locked, undefined);
        assert.equal(repository.isAccountLocked(saved.profile.sessionTimeout), false);

        const after = await User.findById(id).select('+password username mustChangePassword tokenVersion');
        assert.equal(after.password, originalHash);
        assert.equal(await compareHash(TEST_PASSWORD, after.password), true);
        assert.equal(await compareHash('must-not-replace-the-hash', after.password), false);
        assert.equal(after.mustChangePassword, true);
        assert.equal(after.tokenVersion, 2);
        assert.equal(after.username, 'member');
        assert.equal(after.locked, undefined);

        const loaded = await repository.getProfile(id);
        assert.deepEqual(loaded.profile, saved.profile);
    });

    it('keeps a locked account locked and lets a profile write restore it', async () => {
        const created = await User.create({ username: 'locked-member', password: TEST_PASSWORD });
        const id = String(created._id);
        const locked = await repository.saveProfile(id, { ...profileInput, sessionTimeout: 0 });
        assert.equal(locked.ok, true);
        assert.equal(locked.profile.sessionTimeout, 0);
        assert.equal(repository.isAccountLocked(locked.profile.sessionTimeout), true);

        const raised = await repository.updateSessionTimeout(id, 15);
        assert.equal(raised.ok, false);
        assert.equal(raised.reason, 'session_timeout');

        const stillLocked = await repository.getProfile(id);
        assert.equal(stillLocked.profile.sessionTimeout, 0);

        const restored = await repository.saveProfile(id, { ...profileInput, sessionTimeout: 45 });
        assert.equal(restored.ok, true);
        assert.equal(restored.profile.sessionTimeout, 45);
        assert.equal(repository.isAccountLocked(restored.profile.sessionTimeout), false);

        const account = await User.findById(id).select('mustChangePassword tokenVersion');
        assert.equal(account.mustChangePassword, false);
        assert.equal(account.tokenVersion, 0);
    });

    it('applies disconnect timeout rules', async () => {
        const created = await User.create({ username: 'session-member', password: TEST_PASSWORD });
        const id = String(created._id);
        await repository.saveProfile(id, profileInput);

        const longer = await repository.updateSessionTimeout(id, 31);
        assert.equal(longer.ok, false);
        assert.equal(longer.message, 'sessionTimeout cannot exceed the current session length.');

        const shorter = await repository.updateSessionTimeout(id, 12);
        assert.equal(shorter.ok, true);
        assert.equal(shorter.profile.sessionTimeout, 12);
        assert.deepEqual(shorter.profile.permissions, profileInput.permissions);

        const same = await repository.updateSessionTimeout(id, 12);
        assert.equal(same.ok, true);
        assert.equal(same.profile.sessionTimeout, 12);

        const locked = await repository.updateSessionTimeout(id, 0);
        assert.equal(locked.ok, true);
        assert.equal(locked.profile.sessionTimeout, 0);
        assert.equal(repository.isAccountLocked(0), true);
    });

    it('reports missing users and credential-only accounts', async () => {
        const missingId = '507f1f77bcf86cd799439011';
        const missing = await repository.getProfile(missingId);
        assert.equal(missing.ok, false);
        assert.equal(missing.reason, 'not_found');

        const created = await User.create({ username: 'credentials-only', password: TEST_PASSWORD });
        const id = String(created._id);
        const empty = await repository.getProfile(id);
        assert.equal(empty.ok, true);
        assert.equal(empty.profile, null);

        const disconnect = await repository.updateSessionTimeout(id, 0);
        assert.equal(disconnect.ok, false);
        assert.equal(disconnect.reason, 'profile_not_found');

        const invalid = await repository.saveProfile({ $ne: null }, profileInput);
        assert.equal(invalid.ok, false);
        assert.equal(invalid.reason, 'invalid_id');
    });

    it('lists stored profiles and deletes only the selected user', async () => {
        const listed = await repository.listProfiles();
        assert.equal(listed.ok, true);
        assert.equal(listed.profiles.some((profile) => profile.username === 'credentials-only'), false);
        assert.equal(listed.profiles.some((profile) => profile.username === 'member'), true);
        assert.equal(listed.profiles.some((profile) => profile.password !== undefined), false);

        const member = listed.profiles.find((profile) => profile.username === 'member');
        const removed = await repository.deleteUser(member._id);
        assert.equal(removed.ok, true);
        assert.equal(await User.findById(member._id), null);

        const after = await repository.listProfiles();
        assert.equal(after.profiles.some((profile) => profile.username === 'member'), false);
        assert.equal(after.profiles.some((profile) => profile.username === 'locked-member'), true);

        const missing = await repository.deleteUser(member._id);
        assert.equal(missing.ok, false);
        assert.equal(missing.reason, 'not_found');
    });

    it('creates credentials and profile together and rotates the token without rehashing', async () => {
        const created = await repository.createAccount({
            username: 'created-member',
            password: TEST_PASSWORD,
            mustChangePassword: true,
            firstName: 'Created',
            lastName: 'Member',
            sessionTimeout: 20,
            createAt: '2/2/2026',
            permissions: ['View-Movies'],
        });
        assert.equal(created.ok, true);
        assert.equal(created.profile.password, undefined);
        assert.equal(created.profile.sessionTimeout, 20);

        const before = await User.findOne({ username: 'created-member' }).select('+password tokenVersion mustChangePassword');
        const originalHash = before.password;
        assert.equal(before.tokenVersion, 0);
        assert.equal(before.mustChangePassword, true);
        assert.equal(await compareHash(TEST_PASSWORD, originalHash), true);

        const rotated = await repository.saveProfileAndRotateToken(String(before._id), {
            username: 'created-member',
            firstName: 'Created',
            lastName: 'Member',
            sessionTimeout: 18,
            createAt: '2/2/2026',
            permissions: ['View-Subscriptions'],
            password: 'must-not-rehash',
        });
        const after = await User.findById(before._id).select('+password tokenVersion mustChangePassword username');

        assert.equal(rotated.ok, true);
        assert.equal(rotated.tokenVersion, 1);
        assert.deepEqual(rotated.profile.permissions, ['View-Subscriptions']);
        assert.equal(rotated.profile.sessionTimeout, 18);
        assert.equal(after.password, originalHash);
        assert.equal(after.tokenVersion, 1);
        assert.equal(after.mustChangePassword, true);
        assert.equal(after.username, 'created-member');
        assert.equal(await compareHash(TEST_PASSWORD, after.password), true);
    });
});
