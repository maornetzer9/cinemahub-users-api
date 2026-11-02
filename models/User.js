const mongoose = require('mongoose');
const { hashPassword } = require('../utils/bcrypt');

const usersSchema = new mongoose.Schema({
    username: { 
        type: String, 
        required: true, 
        unique: true 
    },
    password: { 
        type: String, 
        set: hashPassword,
        select: false,
    },
    mustChangePassword: {
        type: Boolean,
        default: false,
    },
    tokenVersion: {
        type: Number,
        default: 0,
    },
    // Profile fields are optional so existing credential documents stay valid.
    // The running API stores these fields on the MongoDB user document.
    // A locked account is sessionTimeout <= 0. There is no separate lock flag.
    firstName: { type: String },
    lastName: { type: String },
    sessionTimeout: { type: Number, min: 0 },
    createAt: { type: String },
    permissions: { type: [String], default: undefined },
});

const User = mongoose.model('users', usersSchema);

module.exports = User;