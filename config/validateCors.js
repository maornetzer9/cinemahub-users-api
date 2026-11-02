function validateCorsOrigin() {
    const origin = process.env.ORIGIN;

    if (!origin) {
        return;
    }

    if (origin === '*') {
        console.warn('[CORS] WARNING: ORIGIN is "*" — allows any origin. Use an explicit URL in production.');
    }

    const entries = origin.split(',').map((item) => item.trim()).filter(Boolean);
    entries.forEach((entry) => {
        if (entry === '*') {
            console.warn('[CORS] WARNING: ORIGIN is "*" — allows any origin. Use an explicit URL in production.');
            return;
        }
        if (!/^https?:\/\//i.test(entry)) {
            console.warn(
                `[CORS] WARNING: ORIGIN entry "${entry}" does not look like a valid URL (expected http:// or https://).`
            );
        }
    });
}

module.exports = { validateCorsOrigin };
