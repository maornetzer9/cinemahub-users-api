const rateLimit = require('express-rate-limit');

const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({
            code: 429,
            message: 'Too many login or registration attempts. Please try again in 15 minutes.',
        });
    },
});

module.exports = authRateLimiter;
