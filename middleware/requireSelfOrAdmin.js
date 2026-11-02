const { Responses } = require("../responses/responses");

const requireSelfOrAdmin = (req, res, next) => {
    if (req.user?.username === "Admin") return next();

    const targetId = String(req.body?.user?._id ?? "").trim();
    const callerId = String(req.user?._id ?? "").trim();

    if (targetId && callerId && targetId === callerId) return next();

    const { code, message } = Responses.forbidden;
    return res.status(code).json({ code, message });
};

module.exports = requireSelfOrAdmin;
