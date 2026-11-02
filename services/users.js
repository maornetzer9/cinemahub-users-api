const User = require("../models/User");
const crypto = require("crypto");
const { compareHash } = require("../utils/bcrypt");
const {
    createAccount,
    deleteUser: deleteStoredUser,
    getProfile,
    listProfiles,
    saveProfileAndRotateToken,
    updateSessionTimeout,
} = require("../repositories/userProfileRepository");
const { objectIdString } = require("../utils/objectId");
const { scalarString } = require("../utils/scalarString");
const { Responses, usersResponses } = require("../responses/responses");
const jwtUtils = require("../utils/jwt");
const { sendAdminCreatedUserOnboardingEmail } = require("../utils/mail");

const success = Responses.success;
const error = Responses.internalError;
const unauthorized = Responses.unauthorized;
const badRequest = Responses.badRequest;

const PUBLIC_DEMO_PERMISSIONS = ["View-Movies", "View-Subscriptions"];

function publicUserProfile(record) {
    const source = record && typeof record === "object" ? record : {};
    return {
        _id: source._id,
        firstName: source.firstName,
        lastName: source.lastName,
        sessionTimeout: source.sessionTimeout,
        createAt: source.createAt,
    };
}

function permissionList(record) {
    return Array.isArray(record?.permissions) ? record.permissions : [];
}

function presentUser(profile) {
    return {
        ...publicUserProfile(profile),
        username: profile.username,
        permissions: permissionList(profile),
    };
}

function generateTemporaryPassword(length = 12) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = crypto.randomBytes(length);
    let password = "";
    for (let i = 0; i < length; i += 1) {
        password += chars[bytes[i] % chars.length];
    }
    return password;
}

exports.login = async (req) => {
    try {
        const { username, password } = req.body;
        if (scalarString(username) === null || scalarString(password) === null) {
            return { code: badRequest.code, message: badRequest.message };
        }

        // Check if the username is "Admin"
        const isAdmin = username === "Admin";
        // For regular users, convert username to lowercase
        const normalizedUsername = isAdmin ? username : username.toLowerCase();

        const userRecord = await User.findOne({ username: normalizedUsername }).select('+password');

        // User not found
        if (!userRecord) 
        {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }

        // Password is not set
        if (!userRecord.password) return Responses.unauthorized;

        // Compare the provided password with the stored hashed password
        const isPasswordValid = await compareHash(password, userRecord.password);

        // Invalid password
        if (!isPasswordValid) return Responses.unauthorized;

        // If the user is Admin, return success without additional data
        if (isAdmin) 
        {
            const token = jwtUtils.generateToken(
                { username, tokenVersion: Number(userRecord.tokenVersion ?? 0) },
                '24h'
            );

            const { code, message } = success;
            return { code, message, user: { username: userRecord.username }, token, mustChangePassword: false };
        }

        const profileResult = await getProfile(String(userRecord._id));
        const userData = profileResult.ok ? profileResult.profile : null;

        if (!userData) {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }

        const sessionMinutes = Number(userData.sessionTimeout);
        if (!Number.isFinite(sessionMinutes) || sessionMinutes <= 0) {
            const { code, message } = usersResponses.sessionLocked;
            return { code, message };
        }

        const user = presentUser({ ...userData, username: userRecord.username });

        const token = jwtUtils.generateToken(
            { _id: user._id, permissions: user.permissions, tokenVersion: Number(userRecord.tokenVersion ?? 0) },
            `${sessionMinutes}m`
        );

        const { code, message } = success;
        return { code, message, user, token, mustChangePassword: Boolean(userRecord.mustChangePassword) };
    } 
    catch(err)
    {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
    }
};

exports.register = async (req) => {
    try {
        const { username: name, password } = req.body;

        if (scalarString(name) === null || !name.trim()) {
            return {
                code: badRequest.code,
                message: "Username is required.",
            };
        }

        if (scalarString(password) === null || password.length < 6) {
            return {
                code: badRequest.code,
                message: "Password must be at least 6 characters.",
            };
        }

        if (name.toLowerCase() === "admin") {
            return { code: unauthorized.code, message: unauthorized.message };
        }

        const username = name !== "Admin" && name.toLocaleLowerCase();
        const normalizedUsername = username ? username : name;

        const isUserExists = await User.findOne({ username: normalizedUsername });
        const { code: errorCode, message: errorMessage } = usersResponses.usernameAlreadyTaken;
        if (isUserExists) return { code: errorCode, message: errorMessage };

        const created = await createAccount({
            username: normalizedUsername,
            password,
            mustChangePassword: false,
            firstName: "Demo",
            lastName: "User",
            sessionTimeout: 60,
            createAt: new Date().toLocaleDateString(),
            permissions: PUBLIC_DEMO_PERMISSIONS,
        });
        if (!created.ok && created.reason === "duplicate") {
            return { code: errorCode, message: errorMessage };
        }
        if (!created.ok) return { code: badRequest.code, message: created.message };

        const { code, message } = success;
        return { code, message };
    } catch (err) {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
    }
};

exports.changePasswordAfterFirstLogin = async (req) => {
    try {
        const userId = req.user && req.user._id;
        if (!userId) return Responses.unauthorized;

        const { newPassword } = req.body;
        const trimmedPassword = String(newPassword || "").trim();

        if (!trimmedPassword || trimmedPassword.length < 6) {
            return {
                code: badRequest.code,
                message: "A valid new password is required (minimum 6 characters).",
            };
        }

        const userRecord = await User.findById(userId);
        if (!userRecord) {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }

        if (!userRecord.mustChangePassword) {
            return {
                code: badRequest.code,
                message: "Password change is not required for this account.",
            };
        }

        // Reject a revoked token (issued before a permission edit or prior password change).
        const claimedVersion =
            req.user && req.user.tokenVersion !== undefined
                ? Number(req.user.tokenVersion)
                : -1;
        const recordVersion = Number(userRecord.tokenVersion ?? 0);
        if (claimedVersion !== recordVersion) {
            return Responses.unauthorized;
        }

        await User.findOneAndUpdate(
            { _id: userRecord._id },
            { $set: { password: trimmedPassword, mustChangePassword: false }, $inc: { tokenVersion: 1 } },
            { new: true }
        );

        // Issue a fresh JWT with the incremented tokenVersion so subsequent API calls
        // are not rejected by enforcePasswordChanged on both backends.
        let freshToken = null;
        try {
            const profileResult = await getProfile(String(userRecord._id));
            const userData = profileResult.ok ? profileResult.profile : null;
            if (userData) {
                const sessionMinutes = Number(userData.sessionTimeout);
                if (Number.isFinite(sessionMinutes) && sessionMinutes > 0) {
                    freshToken = jwtUtils.generateToken(
                        {
                            _id: String(userRecord._id),
                            permissions: permissionList(userData),
                            tokenVersion: recordVersion + 1,
                        },
                        `${sessionMinutes}m`
                    );
                }
            }
        } catch {
            // Non-fatal: if token refresh fails the client will be asked to re-login naturally.
        }

        const { code, message } = success;
        return { code, message, ...(freshToken && { token: freshToken }) };
    } catch (err) {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
    }
};


exports.loadingUsers = async (req) => {
    try
    {
        const listed = await listProfiles();
        const users = listed.profiles.map(presentUser);

        const { code, message } = success;
        return { code, message, users }
    }
    catch(err)
    {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
    }
}

exports.addNewUser = async (req) => {
    try
    {
        let user;
        const {
            firstName,
            lastName,
            username: name,
            sessionTimeout,
            permissions,
            email,
            Email: emailAlt,
            userEmail,
        } = req.body;

        if (scalarString(name) === null || !name.trim()) {
            return { code: badRequest.code, message: "username is required." };
        }

        if (name.toLowerCase() === "admin")
            return { code: unauthorized.code, message: unauthorized.message };

        if (scalarString(firstName) === null || scalarString(lastName) === null || !firstName.trim() || !lastName.trim()) {
            return {
                code: badRequest.code,
                message: "firstName and lastName are required.",
            };
        }

        if (!Array.isArray(permissions) || permissions.length === 0) {
            return {
                code: badRequest.code,
                message: "At least one permission is required.",
            };
        }

        const rawEmail = email || emailAlt || userEmail;
        const trimmedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";
        if (!trimmedEmail || !trimmedEmail.includes("@")) {
            return {
                code: badRequest.code,
                message: "A valid email address is required.",
            };
        }

        const generatedPassword = generateTemporaryPassword();

        const username = name !== "Admin" && name.toLocaleLowerCase();

        const normalizedNewUsername = username ? username : name;
        const isUserExists = await User.findOne({ username: normalizedNewUsername });

        const { code: errorCode, message: errorMessage } = usersResponses.usernameAlreadyTaken;
        if (isUserExists) return { code: errorCode, message: errorMessage };

        const created = await createAccount({
            username: normalizedNewUsername,
            password: generatedPassword,
            mustChangePassword: true,
            firstName: String(firstName).trim(),
            lastName: String(lastName).trim(),
            sessionTimeout: Number(sessionTimeout),
            createAt: new Date().toLocaleDateString(),
            permissions,
        });
        if (!created.ok && created.reason === "duplicate") {
            return { code: errorCode, message: errorMessage };
        }
        if (!created.ok) return { code: badRequest.code, message: created.message };

        const newUserData = created.profile;

        try {
            console.info("[addNewUser] sending onboarding email to=%s user=%s", trimmedEmail, normalizedNewUsername);
            await sendAdminCreatedUserOnboardingEmail({
                to: trimmedEmail,
                username: normalizedNewUsername,
                temporaryPassword: generatedPassword,
            });
        } catch (emailErr) {
            console.error("sendAdminCreatedUserOnboardingEmail failed:", emailErr.message);
            const { code } = error;
            return {
                code,
                message: "User was created, but the welcome email could not be sent.",
            };
        }

        user = presentUser(newUserData);

        const { code, message } = success;
        return { code, message, user };
    }
    catch (err) {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
    }
};

exports.editUser = async (req) => {
    try
    {
        let updatedUsers;
        const { _id, firstName, lastName, username, sessionTimeout, permissions } = req.body;

        if (_id == null || (typeof _id === "string" && _id.trim() === "")) {
            return { code: badRequest.code, message: "User _id is required." };
        }
        const normalizedId = objectIdString(_id);
        if (!normalizedId) {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }

        if (scalarString(firstName) === null || scalarString(lastName) === null || !firstName.trim() || !lastName.trim()) {
            return { code: badRequest.code, message: "firstName and lastName are required." };
        }

        if (scalarString(username) === null || !username.trim()) {
            return { code: badRequest.code, message: "username is required." };
        }

        if (!Array.isArray(permissions) || permissions.length === 0) {
            return { code: badRequest.code, message: "At least one permission is required." };
        }

        const trimmedUsername = String(username).trim();
        if (trimmedUsername.toLowerCase() === "admin" && trimmedUsername !== "Admin") {
            return { code: unauthorized.code, message: unauthorized.message };
        }

        const normalizedUsername = trimmedUsername === "Admin" ? "Admin" : trimmedUsername.toLowerCase();

        const duplicateUser = await User.findOne({
            username: normalizedUsername,
            _id: { $ne: normalizedId },
        });
        if (duplicateUser) {
            const { code, message } = usersResponses.usernameAlreadyTaken;
            return { code, message };
        }

        const existing = await getProfile(normalizedId);
        if (!existing.ok) {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }

        const saved = await saveProfileAndRotateToken(normalizedId, {
            username: normalizedUsername,
            firstName: String(firstName).trim(),
            lastName: String(lastName).trim(),
            sessionTimeout: Number(sessionTimeout),
            createAt: existing.profile?.createAt || new Date().toLocaleDateString(),
            permissions,
        });
        if (!saved.ok && saved.reason === "duplicate") {
            const { code, message } = usersResponses.usernameAlreadyTaken;
            return { code, message };
        }
        if (!saved.ok && saved.reason === "not_found") {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }
        if (!saved.ok) return { code: badRequest.code, message: saved.message };

        const listed = await listProfiles({ excludeUsernames: ["Admin"] });
        updatedUsers = listed.profiles.map(presentUser);

        const { code, message } = success;
        return { code, message, users: updatedUsers, user: presentUser(saved.profile) };
    }
    catch(err)
    {
        console.error(err.message);
        if (err.code === 11000) {
            const { code, message } = usersResponses.usernameAlreadyTaken;
            return { code, message };
        }
        const { code, message } = error;
        return { code, message};
    }
};


exports.deleteUser = async (req) => {
    try
    {
        let updatedUsers;
        const { _id } = req.query;
        const id = objectIdString(_id);
        const { code: errorCode, message: errorMessage } = usersResponses.userNotDeleted;
        if (!id) return { code: errorCode, message: errorMessage };

        const removed = await deleteStoredUser(id);
        if (!removed.ok) return { code: errorCode, message: errorMessage };

        const listed = await listProfiles({ excludeUsernames: ["Admin"] });
        updatedUsers = listed.profiles.map(presentUser);

        const { code, message } = success;
        return { code, message, users: updatedUsers };
    }
    catch(err)
    {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
    }
};


exports.disconnect = async (req) => {
    try
    {
        const { user } = req.body;
        const rawId = user?._id;
        if (rawId == null || (typeof rawId === "string" && rawId.trim() === "")) {
            return { code: badRequest.code, message: "User _id is required to update session timeout." };
        }
        const normalizedId = objectIdString(rawId);
        if (!normalizedId) {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }

        const sessionTimeout = Number(user?.sessionTimeout);
        if (!Number.isFinite(sessionTimeout) || sessionTimeout < 0) {
            return { code: badRequest.code, message: "A valid sessionTimeout is required." };
        }

        const profile = await getProfile(normalizedId);
        if (!profile.ok && profile.reason === "not_found") {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }
        if (!profile.ok || !profile.profile) {
            return { code: badRequest.code, message: "User profile not found." };
        }

        const updated = await updateSessionTimeout(normalizedId, sessionTimeout);
        if (!updated.ok && updated.reason === "not_found") {
            const { code, message } = usersResponses.userNotFound;
            return { code, message };
        }
        if (!updated.ok && updated.reason === "profile_not_found") {
            return { code: badRequest.code, message: "User profile not found." };
        }
        if (!updated.ok) {
            return {
                code: badRequest.code,
                message: "sessionTimeout cannot exceed the current session length.",
            };
        }

        const { code, message } = success;
        return { code, message, user: publicUserProfile(updated.profile) };

    }
    catch(err)
    {
        const { code, message } = error;
        console.error(err.message);
        return { code, message };
        
    }
}