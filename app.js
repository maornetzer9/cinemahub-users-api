const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { userRouter } = require('./routes/users');
const { errorHandler } = require('./middleware/error');

const BODY_SIZE_LIMIT = '100kb';

function corsOrigin() {
    const raw = typeof process.env.ORIGIN === 'string' ? process.env.ORIGIN.trim() : '';
    if (!raw) return undefined;
    const list = raw.split(',').map((item) => item.trim()).filter(Boolean);
    if (list.length <= 1) return list[0];
    return list;
}

function createApp() {
    const app = express();
    const corsOptions = { origin: corsOrigin() };

    // One Render hop only. "true" is rejected so a client cannot spoof X-Forwarded-For.
    const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
    if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
        app.set('trust proxy', trustProxyHops);
    }

    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.use(express.json({ limit: BODY_SIZE_LIMIT }));
    app.use(express.urlencoded({ extended: false, limit: BODY_SIZE_LIMIT }));
    app.use(cors(corsOptions));

    app.get('/health', (_req, res) => {
        const ready = mongoose.connection.readyState === 1;
        res.status(ready ? 200 : 503).json({ ok: ready });
    });

    app.use('/users', userRouter);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
