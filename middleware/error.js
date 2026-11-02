const { Responses } = require("../responses/responses");

const errorHandler = (err, req, res, next) => {
    const { code, message } = Responses.internalError;
    console.error(err.message);
    return res.status(500).json({ code, message });
}

module.exports = { errorHandler };