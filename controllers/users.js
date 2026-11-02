const {
    login,
    register,
    addNewUser,
    loadingUsers,
    deleteUser,
    editUser,
    disconnect,
    changePasswordAfterFirstLogin,
} = require("../services/users");

exports.loadingUsersController = async (req, res, next) => {
    try
    {
        const response = await loadingUsers();
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.loginController = async (req, res, next) => {
    try
    {
        const response = await login(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.registerController = async (req, res, next) => {
    try
    {
        const response = await register(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.changePasswordAfterFirstLoginController = async (req, res, next) => {
    try
    {
        const response = await changePasswordAfterFirstLogin(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.addNewUserController = async (req, res, next) => {
    try
    {
        const response = await addNewUser(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.editUserController = async (req, res, next) => {
    try
    {
        const response = await editUser(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.deleteUserController = async (req, res, next) => {
    try
    {
        const response = await deleteUser(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};


exports.disconnectUserController = async (req, res, next) => {
    try
    {
        const response = await disconnect(req);
        return res.status(200).json(response);
    }
    catch(err)
    {
        next(err);
    }
};
