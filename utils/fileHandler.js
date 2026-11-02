const fs = require('fs').promises;
const path = require('path');
const { Responses } = require('../responses/responses');

const success = Responses.success;

const normalizeId = (value) => {
    if (value == null) return '';
    if (typeof value === 'object' && value._id != null) return String(value._id).trim();
    return String(value).trim();
};

const validateUsersJsonRecord = (record) => {
    const _id = normalizeId(record?._id);
    const firstName = String(record?.firstName ?? '').trim();
    const lastName = String(record?.lastName ?? '').trim();

    if (!_id) {
        return { valid: false, message: 'User JSON record requires a non-empty _id.' };
    }
    if (!firstName) {
        return { valid: false, message: 'User JSON record requires firstName.' };
    }
    if (!lastName) {
        return { valid: false, message: 'User JSON record requires lastName.' };
    }

    return {
        valid: true,
        record: {
            ...record,
            _id,
            firstName,
            lastName,
        },
    };
};

const validatePermissionsJsonRecord = (record) => {
    const _id = normalizeId(record?._id);
    if (!_id) {
        return { valid: false, message: 'Permissions JSON record requires a non-empty _id.' };
    }
    if (!Array.isArray(record?.permissions)) {
        return { valid: false, message: 'Permissions JSON record requires a permissions array.' };
    }

    return {
        valid: true,
        record: { _id, permissions: record.permissions },
    };
};

const repositoriesDir = () =>
    process.env.USERS_JSON_DIR
        ? path.resolve(process.env.USERS_JSON_DIR)
        : path.join(__dirname, '../repositories');

const jsonFilePath = (fileName) => path.join(repositoriesDir(), path.basename(fileName));

const readUsersFile = async (fileName) => {
    try {
        const filePath = jsonFilePath(fileName);
        const data = await fs.readFile(filePath, 'utf-8');
        if (!data) return [];
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading file:', err.message);
        throw new Error('Failed to read the user file');
    }
};

const writeUsersFile = async (fileName, users) => {
    try {
        const filePath = jsonFilePath(fileName);
        await fs.writeFile(filePath, JSON.stringify(users, null, 2));
        const { code } = success;
        return { code };
    } catch (err) {
        console.error('Error writing file:', err.message);
        return { code: Responses.internalError.code, message: Responses.fileError.message };
    }
};

const writeUserJson = async (fileName, newUser) => {
    const users = await readUsersFile(fileName);
    const isPermissionsFile = fileName.includes('permissions');

    const validation = isPermissionsFile
        ? validatePermissionsJsonRecord(newUser)
        : validateUsersJsonRecord(newUser);

    if (!validation.valid) {
        return { code: Responses.badRequest.code, message: validation.message };
    }

    const record = validation.record;
    const existingUserIndex = users.findIndex((user) => String(user._id) === String(record._id));

    if (existingUserIndex !== -1) {
        users.splice(existingUserIndex, 1, record);
    } else {
        users.push(record);
    }

    const writeResult = await writeUsersFile(fileName, users);
    if (writeResult.code !== 200) {
        return writeResult;
    }

    const { code } = success;
    return { code, data: users };
};

const deleteUserJson = async (fileName, _id) => {
    try {
        const normalizedId = normalizeId(_id);
        if (!normalizedId) {
            return { code: Responses.badRequest.code, message: 'Cannot delete JSON record without _id.' };
        }

        const getUsers = await readUsersFile(fileName);
        const updatedUsers = getUsers.filter((user) => String(user._id) !== normalizedId);

        await writeUsersFile(fileName, updatedUsers);

        const { code } = success;
        return { code, data: updatedUsers || [] };
    } catch (err) {
        console.error('Error in deleteUserJson:', err.message);
        throw new Error('Failed to update the user file');
    }
};

module.exports = {
    readUsersFile,
    writeUsersFile,
    writeUserJson,
    deleteUserJson,
    normalizeId,
    validateUsersJsonRecord,
    validatePermissionsJsonRecord,
};
