const REQUIRED_VARS = ['SECRET_KEY', 'MONGOOSE_URI', 'ORIGIN'];

function validateEnv() {
    const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
}

module.exports = { validateEnv };
