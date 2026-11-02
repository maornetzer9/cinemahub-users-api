const bcrypt = require('bcryptjs');
const saltRounds = 10;

const encryptionPassword =
{
    // Must remain synchronous — used as a Mongoose schema `set` transformer,
    // which does not support async functions.
    hashPassword: function(myPlaintextPassword)
    {
        const salt = bcrypt.genSaltSync(saltRounds);
        const hash = bcrypt.hashSync(myPlaintextPassword, salt);
        return hash;
    },

    compareHash: (myPlaintextPassword, hash) => bcrypt.compare(myPlaintextPassword, hash),
};


module.exports = encryptionPassword