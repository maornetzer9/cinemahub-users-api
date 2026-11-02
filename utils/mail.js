const path = require("path");
const nodemailer = require("nodemailer");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

let cachedGenericTransport = null;

const GMAIL_HOST = "smtp.gmail.com";
const GMAIL_PORT_SSL = 465;
const GMAIL_PORT_STARTTLS = 587;

function trimEnv(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

/**
 * Gmail app passwords are 16 characters; Google often shows them in 4x4 with spaces.
 * SMTP auth expects the password without spaces. Also strips accidental wrapping quotes from .env.
 */
function normalizeSmtpPassword(raw) {
    let pass = trimEnv(raw);
    if (pass.length >= 2 && pass.startsWith('"') && pass.endsWith('"')) {
        pass = pass.slice(1, -1);
    }
    if (pass.length >= 2 && pass.startsWith("'") && pass.endsWith("'")) {
        pass = pass.slice(1, -1);
    }
    return pass.replace(/\s+/g, "");
}

function isLikelyEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

/**
 * Gmail — פורט 465 עם SSL מלא (implicit TLS).
 * מסלול אחד קבוע: host + port 465 + secure: true.
 */
function createGmailSmtpTransport465(user, pass) {
    return nodemailer.createTransport({
        host: GMAIL_HOST,
        port: GMAIL_PORT_SSL,
        secure: true,
        auth: { user, pass },
        connectionTimeout: 25000,
        greetingTimeout: 25000,
        family: 4,
        tls: { minVersion: "TLSv1.2" },
    });
}

/**
 * Gmail — פורט 587 עם STARTTLS (לא SSL מההתחלה).
 * משווה ל-SMTP_PORT מה-.env: אם הוגדר 465, הפורט הלוגי של submission עדיין 587 בניסיון הזה;
 * משמש כנתיב חלופי כשחומת אש חוסמת 465 או להפך.
 */
function createGmailSmtpTransport587(user, pass) {
    const configuredPort = Number(trimEnv(process.env.SMTP_PORT)) || GMAIL_PORT_STARTTLS;
    const isTypicalSubmissionPort =
        configuredPort === GMAIL_PORT_STARTTLS || configuredPort === 25;

    if (process.env.SMTP_DEBUG === "1") {
        console.info(
            "[mail:587] SMTP_PORT from env=%s (587 transport always uses port %s STARTTLS; typicalSubmission=%s)",
            configuredPort,
            GMAIL_PORT_STARTTLS,
            isTypicalSubmissionPort
        );
    }

    return nodemailer.createTransport({
        host: GMAIL_HOST,
        port: GMAIL_PORT_STARTTLS,
        secure: false,
        requireTLS: true,
        auth: { user, pass },
        connectionTimeout: 25000,
        greetingTimeout: 25000,
        family: 4,
        tls: { minVersion: "TLSv1.2" },
        logger: process.env.SMTP_DEBUG === "1",
        debug: process.env.SMTP_DEBUG === "1",
    });
}

/**
 * סדר ניסיונות Gmail: אם ב-.env ביקשו במפורש 465 — מתחילים ב-465 ואז 587; אחרת 587 ואז 465.
 */
function buildOrderedGmailTransports(user, pass) {
    const configuredPort = Number(trimEnv(process.env.SMTP_PORT)) || GMAIL_PORT_STARTTLS;
    const t465 = createGmailSmtpTransport465(user, pass);
    const t587 = createGmailSmtpTransport587(user, pass);

    if (configuredPort === GMAIL_PORT_SSL) {
        return [t465, t587];
    }
    return [t587, t465];
}

function getGenericSmtpTransport(host, user, pass, port, secure) {
    if (cachedGenericTransport) {
        return cachedGenericTransport;
    }
    cachedGenericTransport = nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS: !secure && port === 587,
        auth: { user, pass },
        connectionTimeout: 25000,
        greetingTimeout: 25000,
    });
    return cachedGenericTransport;
}

function getSmtpTransportsForSend() {
    const hostRaw = trimEnv(process.env.SMTP_HOST);
    const user = trimEnv(process.env.SMTP_USER);
    const pass = normalizeSmtpPassword(process.env.SMTP_PASS);
    const port = Number(trimEnv(process.env.SMTP_PORT)) || 587;
    const secure = process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true";

    if (!user || !pass) {
        throw new Error(
            "SMTP is not configured. Set SMTP_USER and SMTP_PASS (see CLAUDE.md)."
        );
    }

    const hostLower = hostRaw.toLowerCase();
    const isGmail =
        !hostRaw || hostLower === "smtp.gmail.com" || hostLower === "gmail";

    if (isGmail) {
        return buildOrderedGmailTransports(user, pass);
    }

    if (!hostRaw) {
        throw new Error("SMTP_HOST is required for non-Gmail SMTP.");
    }

    return [getGenericSmtpTransport(hostRaw, user, pass, port, secure)];
}

function extractAngleBracketEmail(raw) {
    const m = String(raw || "").match(/<([^>]+)>/);
    if (!m) return "";
    const inner = trimEnv(m[1]);
    return isLikelyEmail(inner) ? inner : "";
}

/**
 * Gmail (and many providers) require the authenticated mailbox to match the envelope From address.
 * If MAIL_FROM differs from SMTP_USER, sending fails at the provider — use SMTP_USER.
 */
function resolveFromAddress() {
    const smtpUser = trimEnv(process.env.SMTP_USER);
    if (!smtpUser || !isLikelyEmail(smtpUser)) {
        throw new Error(
            "SMTP_USER must be your mailbox email (the same account as SMTP_PASS / app password)."
        );
    }

    const mailFrom = trimEnv(process.env.MAIL_FROM);
    if (!mailFrom) {
        return smtpUser;
    }

    const bracketEmail = extractAngleBracketEmail(mailFrom);
    const plainEmail = isLikelyEmail(mailFrom) ? mailFrom : "";
    const declaredMailbox = bracketEmail || plainEmail;

    if (
        declaredMailbox &&
        declaredMailbox.toLowerCase() === smtpUser.toLowerCase()
    ) {
        return mailFrom.includes("<") ? mailFrom : declaredMailbox;
    }

    return smtpUser;
}

function buildOnboardingText(username, temporaryPassword) {
    return [
        "Your account has been created. Use the following credentials to sign in for the first time.",
        "",
        `Username: ${username}`,
        `Temporary password: ${temporaryPassword}`,
        "",
        "This password is for your first login. After you sign in, you will be required to change it.",
    ].join("\n");
}

/**
 * Sends first-login credentials set by an admin. Plain password exists only in memory for the SMTP round-trip;
 * the DB stores the bcrypt hash only (via the User model).
 *
 * Flow (admin): POST /users/add → addNewUser → await sendAdminCreatedUserOnboardingEmail({ to, username, temporaryPassword }).
 */
async function sendAdminCreatedUserOnboardingEmail({ to, username, temporaryPassword }) {
    const normalizedTo = trimEnv(to);
    if (!isLikelyEmail(normalizedTo)) {
        throw new Error("Invalid recipient email address.");
    }
    const plain = String(temporaryPassword || "").trim();
    if (!plain) {
        throw new Error("Missing temporary password for onboarding email.");
    }

    const from = resolveFromAddress();
    const subject = "Your account and temporary password";
    const text = buildOnboardingText(username, plain);

    const transports = getSmtpTransportsForSend();
    let lastErr;
    for (let i = 0; i < transports.length; i += 1) {
        try {
            const info = await transports[i].sendMail({
                from,
                to: normalizedTo,
                subject,
                text,
            });
            console.info(
                "[mail] Onboarding email sent messageId=%s to=%s attempt=%s/%s",
                info && info.messageId,
                normalizedTo,
                i + 1,
                transports.length
            );
            return;
        } catch (err) {
            lastErr = err;
            console.error(`[mail] send attempt ${i + 1} failed:`, err && err.message);
        }
    }
    throw new Error(
        lastErr
            ? `All SMTP attempts failed. Last: ${lastErr.message}`
            : "SMTP send failed (no attempts)."
    );
}

module.exports = { sendAdminCreatedUserOnboardingEmail };
