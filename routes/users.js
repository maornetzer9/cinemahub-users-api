const express = require('express');
const {
    loginController,
    registerController,
    addNewUserController,
    loadingUsersController,
    deleteUserController,
    editUserController,
    disconnectUserController,
    changePasswordAfterFirstLoginController,
} = require('../controllers/users');
const authMiddleware = require('../middleware/auth');
const enforcePasswordChanged = require('../middleware/enforcePasswordChanged');
const requireAdmin = require('../middleware/requireAdmin');
const requireSelfOrAdmin = require('../middleware/requireSelfOrAdmin');
const authRateLimiter = require('../middleware/authRateLimit');

const router = express.Router();

router.post('/login',     authRateLimiter, loginController                        );
router.post('/register',  authRateLimiter, registerController                     );
router.put('/change-password', authMiddleware, changePasswordAfterFirstLoginController);
router.get('/',           authMiddleware, enforcePasswordChanged, requireAdmin, loadingUsersController      );
router.put('/edit',       authMiddleware, enforcePasswordChanged, requireAdmin, editUserController          );
router.post('/add',       authMiddleware, enforcePasswordChanged, requireAdmin, addNewUserController        );
router.delete('/delete',  authMiddleware, enforcePasswordChanged, requireAdmin, deleteUserController        );
router.put('/disconnect', authMiddleware, enforcePasswordChanged, requireSelfOrAdmin, disconnectUserController    );

module.exports = { userRouter: router };
