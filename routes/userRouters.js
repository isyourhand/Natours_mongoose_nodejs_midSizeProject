const express = require('express');
const {
    getAllUsers,
    createUser,
    getUser,
    updateUser,
    deleteUser,
    updateMe,
    deleteMe,
    getMe,
    uploadUserPhoto,
    resizeUserPhoto,
} = require('./../controllers/userController');
const authController = require('./../controllers/authController');
const bookingRouter = require('./../routes/bookingRouters');

const router = express.Router();

router.use('/:userId/bookings', bookingRouter);

router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.get('/login', authController.logout);
router.post('/forgotPassword', authController.forgotPassword);
router.patch('/resetPassword/:token', authController.resetPassword);

// All the below router will run after 'protect'. Protect all routes after this middleware.
router.use(authController.protect);

router.get('/me', getMe, getUser);
router.patch('/updatePassword', authController.updatePassword);
router.patch('/updateMe', uploadUserPhoto, resizeUserPhoto, updateMe);
router.delete('/deleteMe', deleteMe);

router.use(authController.restrictTo('admin'));

router.route('/').get(getAllUsers).post(createUser);
router.route('/:id').get(getUser).patch(updateUser).delete(deleteUser);

module.exports = router;
