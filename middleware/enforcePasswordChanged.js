const User = require("../models/User");
const { Responses, sessionResponses } = require("../responses/responses");

const passwordChangeRequired = {
    code: 403,
    message: "You must change your password before continuing.",
};

const enforcePasswordChanged = async (req, res, next) => {
    try {
        // A claim of -1 means the token pre-dates tokenVersion (no field present).
        // Those tokens are always rejected once the DB has version 0 stored.
        const claimedVersion =
            req.user && req.user.tokenVersion !== undefined
                ? Number(req.user.tokenVersion)
                : -1;

        let userRecord;

        const userId = req.user && req.user._id;
        if (userId) {
            userRecord = await User.findById(userId).select("mustChangePassword tokenVersion");
        } else if (req.user?.username === "Admin") {
            userRecord = await User.findOne({ username: "Admin" }).select(
                "mustChangePassword tokenVersion"
            );
        } else {
            // No recognizable identity; auth middleware already validated the signature.
            return next();
        }

        // Deleted user → revoked.
        if (!userRecord) {
            const { code, message } = sessionResponses.sessionExpired;
            return res.status(code).json({ code, message });
        }

        // Stale token (version mismatch or pre-tokenVersion token) → revoked.
        const recordVersion = Number(userRecord.tokenVersion ?? 0);
        if (claimedVersion !== recordVersion) {
            const { code, message } = sessionResponses.sessionExpired;
            return res.status(code).json({ code, message });
        }

        // Password change still pending → 403.
        if (userRecord.mustChangePassword) {
            const { code, message } = passwordChangeRequired;
            return res.status(code).json({ code, message });
        }

        return next();
    } catch (err) {
        const { code, message } = Responses.internalError;
        console.error(err.message);
        return res.status(code).json({ code, message });
    }
};

module.exports = enforcePasswordChanged;
