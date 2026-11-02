const { Responses } = require("../responses/responses");

const requireAdmin = (req, res, next) => {
    if (req.user?.username === "Admin") return next();

    const { code, message } = Responses.forbidden;
    return res.status(code).json({ code, message });
};

module.exports = requireAdmin;
