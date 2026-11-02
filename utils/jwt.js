require('dotenv').config();
const jwt = require('jsonwebtoken');

const secretKey = process.env.SECRET_KEY;
const jwtUtils = {
    
    generateToken: function(payload, expiresIn = '24h')
    {
        const options = { expiresIn };
        return jwt.sign(payload, secretKey, options);
    },

    verifyToken: function(token)
    {
        try
        {
            if(!token) return null;
            return jwt.verify(token, secretKey);
        }
        catch(err)
        {
            console.error('Token verification failed:', err.message);
            return null;
        }
    } 
}

module.exports = jwtUtils;