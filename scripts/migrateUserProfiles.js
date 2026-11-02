const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const { objectIdString } = require('../utils/objectId');
const { isAccountLocked, saveProfile } = require('../repositories/userProfileRepository');

const DEFAULT_JSON_DIR = path.join(__dirname, '..', 'repositories');

function isPatternRemote(uri) {
    return !uri || /mongodb\+srv|mongodb\.net|render\.com/i.test(uri);
}

function parsedHostname(uri) {
    return new URL(uri).hostname;
}

function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost';
}

function assertMigrationTarget(uri, host, options = {}) {
    const { allowRemote = false, allowRemoteWrite = false, mode } = options;
    if (isPatternRemote(uri) && !allowRemote) {
        throw new Error('Refusing to run migration against a remote database');
    }

    let hostname = '';
    try {
        hostname = parsedHostname(uri);
    } catch {
        throw new Error('Refusing to run migration against an invalid database URI');
    }

    const localUri = isLoopbackHost(hostname);
    if (!localUri && !allowRemote) {
        throw new Error('Refusing to run migration against a non-local database');
    }

    const remote = isPatternRemote(uri) || !localUri;
    if (remote && mode === 'apply' && !allowRemoteWrite) {
        throw new Error('Refusing to write to a remote database without explicit authorization');
    }

    if (host && isLoopbackHost(host) !== localUri) {
        throw new Error('Refusing to run migration because the connected database does not match the authorized target');
    }
}

function assertLocalMongoTarget(uri, host) {
    assertMigrationTarget(uri, host);
}

function canonicalId(value) {
    if (typeof value !== 'string') return null;
    const id = objectIdString(value);
    return id ? id.toLowerCase() : null;
}

function emptyResult(mode) {
    return {
        ok: false,
        mode: mode || null,
        wrote: false,
        errors: [],
        updates: [],
        missingAccounts: [],
        mongoWithoutProfile: [],
        orphanPermissions: [],
        applied: [],
    };
}

function parseArgs(argv, defaultDir = DEFAULT_JSON_DIR) {
    let mode = null;
    let jsonDir = defaultDir;
    let allowRemote = false;
    let allowRemoteWrite = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--dry-run' || arg === '--apply') {
            if (mode) {
                return { ok: false, message: 'Choose exactly one mode: --dry-run or --apply.' };
            }
            mode = arg === '--dry-run' ? 'dry-run' : 'apply';
            continue;
        }
        if (arg === '--authorize-remote') {
            allowRemote = true;
            continue;
        }
        if (arg === '--authorize-remote-write') {
            allowRemoteWrite = true;
            continue;
        }
        if (arg === '--json-dir') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                return { ok: false, message: '--json-dir requires a directory.' };
            }
            jsonDir = value;
            index += 1;
            continue;
        }
        return { ok: false, message: 'Unknown argument. Use --dry-run or --apply.' };
    }

    if (!mode) {
        return { ok: false, message: 'Choose exactly one mode: --dry-run or --apply.' };
    }

    return {
        ok: true,
        mode,
        jsonDir: path.resolve(jsonDir),
        allowRemote,
        allowRemoteWrite,
    };
}

function loadJsonArray(filePath) {
    const name = path.basename(filePath);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return { ok: false, error: `Cannot read ${name}. It must be a JSON array.` };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, error: `${name} must be a JSON array.` };
    }
    return { ok: true, records: parsed };
}

function duplicateIds(records) {
    const seen = new Set();
    const duplicates = new Set();
    records.forEach((record) => {
        const id = canonicalId(record?._id);
        if (!id) return;
        if (seen.has(id)) duplicates.add(id);
        seen.add(id);
    });
    return [...duplicates];
}

function validateProfiles(records) {
    const errors = [];
    const profiles = [];
    const duplicates = duplicateIds(records);

    duplicates.forEach((id) => errors.push(`Duplicate _id in users.json: ${id}`));

    records.forEach((record, index) => {
        const id = canonicalId(record?._id);
        if (!id) {
            errors.push(`Invalid _id in users.json at index ${index}.`);
            return;
        }
        if (duplicates.includes(id)) return;

        const firstName = typeof record?.firstName === 'string' ? record.firstName.trim() : '';
        const lastName = typeof record?.lastName === 'string' ? record.lastName.trim() : '';
        const createAt = typeof record?.createAt === 'string' ? record.createAt.trim() : '';
        const sessionTimeout = record?.sessionTimeout;
        let recordIsValid = true;

        if (!firstName || !lastName) {
            errors.push(`Invalid name in users.json at index ${index}.`);
            recordIsValid = false;
        }
        if (!createAt) {
            errors.push(`Invalid createAt in users.json at index ${index}.`);
            recordIsValid = false;
        }
        if (typeof sessionTimeout !== 'number' || !Number.isFinite(sessionTimeout) || sessionTimeout < 0) {
            errors.push(`Invalid sessionTimeout in users.json at index ${index}.`);
            recordIsValid = false;
        }
        if (!recordIsValid) return;

        profiles.push({ _id: id, firstName, lastName, createAt, sessionTimeout });
    });

    return { errors, profiles: errors.length ? [] : profiles };
}

function validatePermissions(records) {
    const errors = [];
    const permissionsById = new Map();
    const duplicates = duplicateIds(records);

    duplicates.forEach((id) => errors.push(`Duplicate _id in permissions.json: ${id}`));

    records.forEach((record, index) => {
        const id = canonicalId(record?._id);
        if (!id) {
            errors.push(`Invalid _id in permissions.json at index ${index}.`);
            return;
        }
        if (duplicates.includes(id)) return;
        if (!Array.isArray(record?.permissions) || record.permissions.some((entry) => typeof entry !== 'string')) {
            errors.push(`Invalid permissions in permissions.json at index ${index}.`);
            return;
        }
        permissionsById.set(id, [...record.permissions]);
    });

    return { errors, permissionsById: errors.length ? new Map() : permissionsById };
}

async function migrateUserProfiles({
    jsonDir,
    mode,
    allowRemote = false,
    allowRemoteWrite = false,
}) {
    const result = emptyResult(mode);
    if (mode !== 'dry-run' && mode !== 'apply') {
        result.errors.push('Choose exactly one mode: --dry-run or --apply.');
        return result;
    }

    try {
        assertMigrationTarget(process.env.MONGOOSE_URI, mongoose.connection.host, {
            allowRemote,
            allowRemoteWrite,
            mode,
        });
    } catch (err) {
        result.errors.push(err.message);
        return result;
    }

    if (mongoose.connection.readyState !== 1) {
        result.errors.push('MongoDB is not connected.');
        return result;
    }

    const usersFile = loadJsonArray(path.join(jsonDir, 'users.json'));
    const permissionsFile = loadJsonArray(path.join(jsonDir, 'permissions.json'));
    if (!usersFile.ok) result.errors.push(usersFile.error);
    if (!permissionsFile.ok) result.errors.push(permissionsFile.error);
    if (result.errors.length) return result;

    const profiles = validateProfiles(usersFile.records);
    const permissions = validatePermissions(permissionsFile.records);
    result.errors.push(...profiles.errors, ...permissions.errors);
    if (result.errors.length) return result;

    const accounts = await User.find({}).select('username');
    const accountsById = new Map(accounts.map((account) => [String(account._id), account]));
    const profileIds = new Set(profiles.profiles.map((profile) => profile._id));

    permissions.permissionsById.forEach((_permissions, id) => {
        if (!profileIds.has(id)) result.orphanPermissions.push({ _id: id });
    });

    profiles.profiles.forEach((profile) => {
        const account = accountsById.get(profile._id);
        if (!account) {
            result.missingAccounts.push({ _id: profile._id });
            return;
        }

        const permissionList = permissions.permissionsById.has(profile._id)
            ? permissions.permissionsById.get(profile._id)
            : [];

        result.updates.push({
            _id: profile._id,
            username: account.username,
            firstName: profile.firstName,
            lastName: profile.lastName,
            createAt: profile.createAt,
            sessionTimeout: profile.sessionTimeout,
            locked: isAccountLocked(profile.sessionTimeout),
            permissions: permissionList,
        });
    });

    accounts.forEach((account) => {
        const id = String(account._id);
        if (profileIds.has(id)) return;
        result.mongoWithoutProfile.push({ _id: id, username: account.username });
    });

    if (mode === 'dry-run') {
        result.ok = true;
        return result;
    }

    for (const update of result.updates) {
        const saved = await saveProfile(update._id, {
            firstName: update.firstName,
            lastName: update.lastName,
            createAt: update.createAt,
            sessionTimeout: update.sessionTimeout,
            permissions: update.permissions,
        });
        if (!saved.ok) {
            result.errors.push(saved.message);
            result.wrote = result.applied.length > 0;
            return result;
        }
        result.applied.push(update._id);
    }

    result.ok = true;
    result.wrote = result.applied.length > 0;
    return result;
}

function printResult(result) {
    console.log(`mode: ${result.mode}`);
    console.log(`wrote: ${result.wrote}`);
    console.log(`matched: ${result.updates.length}`);
    console.log(`missingAccounts: ${result.missingAccounts.length}`);
    console.log(`mongoWithoutProfile: ${result.mongoWithoutProfile.length}`);
    console.log(`orphanPermissions: ${result.orphanPermissions.length}`);
    result.errors.forEach((error) => console.error(error));
    result.updates.forEach((update) => {
        console.log(
            `update ${update._id} sessionTimeout=${update.sessionTimeout} permissions=${update.permissions.length}`
        );
    });
    result.missingAccounts.forEach((account) => console.log(`missing-account ${account._id}`));
    result.mongoWithoutProfile.forEach((account) => {
        console.log(`missing-profile ${account._id}`);
    });
}

async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed.ok) {
        console.error(parsed.message);
        process.exitCode = 1;
        return;
    }

    try {
        assertMigrationTarget(process.env.MONGOOSE_URI, null, {
            allowRemote: parsed.allowRemote,
            allowRemoteWrite: parsed.allowRemoteWrite,
            mode: parsed.mode,
        });
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    try {
        await mongoose.connect(process.env.MONGOOSE_URI);
        const result = await migrateUserProfiles({
            jsonDir: parsed.jsonDir,
            mode: parsed.mode,
            allowRemote: parsed.allowRemote,
            allowRemoteWrite: parsed.allowRemoteWrite,
        });
        printResult(result);
        process.exitCode = result.ok ? 0 : 1;
    } catch {
        console.error('Migration could not connect to the database');
        process.exitCode = 1;
    } finally {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    }
}

module.exports = {
    assertLocalMongoTarget,
    assertMigrationTarget,
    parseArgs,
    migrateUserProfiles,
};

if (require.main === module) {
    main().catch(() => {
        console.error('Migration failed');
        process.exitCode = 1;
    });
}
