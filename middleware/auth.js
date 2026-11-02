const { Responses, sessionResponses } = require("../responses/responses");
const { verifyToken } = require("../utils/jwt");

const authMiddleware = async (req, res, next) => {
    try
    {
        const token = req.headers.authorization?.split(" ")[1]; 
        const { code, message } = sessionResponses.sessionExpired;

        const verify = await verifyToken(token);
        
        if(!verify) return res.status(code).json({ code, message });

        req.user = verify;
        next();
    }
    catch(err)
    {
        const { code, message } = Responses.internalError;
        console.error(err.message);
        return res.status(code).json({ code, message });
    }
}

module.exports = authMiddleware;