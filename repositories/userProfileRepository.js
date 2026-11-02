const User = require('../models/User');
const { objectIdString } = require('../utils/objectId');

const MESSAGES = {
    invalidId: 'A valid user id is required.',
    notFound: 'User not found',
    profileNotFound: 'User profile not found.',
    sessionTimeout: 'sessionTimeout cannot exceed the current session length.',
    invalidTimeout: 'A valid sessionTimeout is required.',
    invalidName: 'firstName and lastName are required.',
    invalidPermissions: 'permissions must be an array of strings.',
    invalidCreateAt: 'createAt is required.',
};

function failure(reason, message) {
    return { ok: false, reason, message };
}

function isAccountLocked(sessionTimeout) {
    const minutes = Number(sessionTimeout);
    return !Number.isFinite(minutes) || minutes <= 0;
}

function hasStoredProfile(user) {
    return Boolean(
        user
        && typeof user.firstName === 'string'
        && user.firstName.trim()
        && typeof user.lastName === 'string'
        && user.lastName.trim()
        && typeof user.createAt === 'string'
        && user.createAt.trim()
        && Number.isFinite(Number(user.sessionTimeout))
        && Number(user.sessionTimeout) >= 0
    );
}

function toProfile(user) {
    const sessionTimeout = Number(user.sessionTimeout);
    return {
        _id: String(user._id),
        firstName: user.firstName,
        lastName: user.lastName,
        sessionTimeout,
        createAt: user.createAt,
        username: user.username,
        permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
    };
}

function normalizeProfileInput(input) {
    const source = input && typeof input === 'object' ? input : {};
    const firstName = typeof source.firstName === 'string' ? source.firstName.trim() : '';
    const lastName = typeof source.lastName === 'string' ? source.lastName.trim() : '';
    const createAt = typeof source.createAt === 'string' ? source.createAt.trim() : '';
    const sessionTimeout = Number(source.sessionTimeout);

    if (!firstName || !lastName) return failure('invalid_profile', MESSAGES.invalidName);
    if (!createAt) return failure('invalid_profile', MESSAGES.invalidCreateAt);
    if (!Number.isFinite(sessionTimeout) || sessionTimeout < 0) {
        return failure('invalid_profile', MESSAGES.invalidTimeout);
    }
    if (!Array.isArray(source.permissions) || source.permissions.some((entry) => typeof entry !== 'string')) {
        return failure('invalid_profile', MESSAGES.invalidPermissions);
    }

    return {
        ok: true,
        profile: {
            firstName,
            lastName,
            createAt,
            sessionTimeout,
            permissions: [...source.permissions],
        },
    };
}

async function getProfile(userId) {
    const id = objectIdString(userId);
    if (!id) return failure('invalid_id', MESSAGES.invalidId);

    const user = await User.findById(id).select('username firstName lastName sessionTimeout createAt permissions');
    if (!user) return failure('not_found', MESSAGES.notFound);
    if (!hasStoredProfile(user)) return { ok: true, profile: null };
    return { ok: true, profile: toProfile(user) };
}

async function listProfiles({ excludeUsernames = [] } = {}) {
    const query = {
        firstName: { $type: 'string', $ne: '' },
        lastName: { $type: 'string', $ne: '' },
        createAt: { $type: 'string', $ne: '' },
        sessionTimeout: { $type: 'number', $gte: 0 },
    };
    if (excludeUsernames.length > 0) query.username = { $nin: excludeUsernames };

    const users = await User.find(query)
        .select('username firstName lastName sessionTimeout createAt permissions')
        .sort({ _id: 1 });

    return {
        ok: true,
        profiles: users.filter(hasStoredProfile).map(toProfile),
    };
}

async function saveProfile(userId, input) {
    const id = objectIdString(userId);
    if (!id) return failure('invalid_id', MESSAGES.invalidId);

    const normalized = normalizeProfileInput(input);
    if (!normalized.ok) return normalized;

    const updated = await User.findOneAndUpdate(
        { _id: id },
        { $set: normalized.profile },
        { new: true }
    ).select('username firstName lastName sessionTimeout createAt permissions');

    if (!updated) return failure('not_found', MESSAGES.notFound);
    return { ok: true, profile: toProfile(updated) };
}

async function updateSessionTimeout(userId, requestedTimeout) {
    const id = objectIdString(userId);
    if (!id) return failure('invalid_id', MESSAGES.invalidId);

    const requested = Number(requestedTimeout);
    if (!Number.isFinite(requested) || requested < 0) {
        return failure('invalid_profile', MESSAGES.invalidTimeout);
    }

    const existing = await User.findById(id).select('username firstName lastName sessionTimeout createAt permissions');
    if (!existing) return failure('not_found', MESSAGES.notFound);
    if (!hasStoredProfile(existing)) return failure('profile_not_found', MESSAGES.profileNotFound);

    const stored = Number(existing.sessionTimeout);
    if (requested > stored) return failure('session_timeout', MESSAGES.sessionTimeout);

    const updated = await User.findOneAndUpdate(
        { _id: id, sessionTimeout: stored },
        { $set: { sessionTimeout: requested } },
        { new: true }
    ).select('username firstName lastName sessionTimeout createAt permissions');

    if (!updated) return failure('conflict', MESSAGES.sessionTimeout);
    return { ok: true, profile: toProfile(updated) };
}

async function createAccount(input) {
    const normalized = normalizeProfileInput(input);
    if (!normalized.ok) return normalized;

    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!username || !password) return failure('invalid_profile', 'username and password are required.');

    try {
        const user = await User.create({
            username,
            password,
            mustChangePassword: Boolean(input.mustChangePassword),
            ...normalized.profile,
        });
        return { ok: true, profile: toProfile(user) };
    } catch (err) {
        if (err && err.code === 11000) return failure('duplicate', 'Username already taken');
        throw err;
    }
}

async function saveProfileAndRotateToken(userId, input) {
    const id = objectIdString(userId);
    if (!id) return failure('invalid_id', MESSAGES.invalidId);

    const normalized = normalizeProfileInput(input);
    if (!normalized.ok) return normalized;

    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    if (!username) return failure('invalid_profile', 'username is required.');

    try {
        const updated = await User.findOneAndUpdate(
            { _id: id },
            {
                $set: { username, ...normalized.profile },
                $inc: { tokenVersion: 1 },
            },
            { new: true }
        ).select('username firstName lastName sessionTimeout createAt permissions tokenVersion');

        if (!updated) return failure('not_found', MESSAGES.notFound);
        return {
            ok: true,
            profile: toProfile(updated),
            tokenVersion: Number(updated.tokenVersion),
        };
    } catch (err) {
        if (err && err.code === 11000) return failure('duplicate', 'Username already taken');
        throw err;
    }
}

async function deleteUser(userId) {
    const id = objectIdString(userId);
    if (!id) return failure('invalid_id', MESSAGES.invalidId);

    const deleted = await User.findOneAndDelete({ _id: id });
    if (!deleted) return failure('not_found', MESSAGES.notFound);
    return { ok: true };
}

module.exports = {
    isAccountLocked,
    getProfile,
    listProfiles,
    saveProfile,
    createAccount,
    saveProfileAndRotateToken,
    updateSessionTimeout,
    deleteUser,
};
