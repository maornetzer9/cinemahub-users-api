const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

function objectIdString(value) {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    if (!OBJECT_ID.test(id)) return null;
    return id;
}

module.exports = { objectIdString };
