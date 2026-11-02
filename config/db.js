require('dotenv').config();
const mongoose = require('mongoose');

const ORIGIN = process.env.ORIGIN;
const MONGOOSE_URI = process.env.MONGOOSE_URI;

const mongooseConnection = async (next) => {
    try {
        await mongoose.connect(MONGOOSE_URI);

        const name = mongoose.connection.name;
        const state = mongoose.connection.readyState;
        
        console.info({
            name,
            ORIGIN,
            connection: state === 1 ? true : false
        });
        if(next) next();
    } catch(err) {
        console.error('Error connecting to MongoDB:', err.message);
        if(next) next(err);
    }
};

const mongooseSession = (next) => mongooseConnection(next);

async function closeDataConnections() {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

module.exports = { mongooseSession, closeDataConnections };
