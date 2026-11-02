function scalarString(value) {
    return typeof value === 'string' ? value : null;
}

module.exports = { scalarString };
