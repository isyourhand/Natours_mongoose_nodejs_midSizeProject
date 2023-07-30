const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const catchAsync = require('../Utils/catchAsync');
const User = require('../models/userModel');
const AppError = require('../Utils/appError');
const Email = require('../Utils/email');

const signToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN,
    });
};

const createSendToken = (user, statusCode, req, res) => {
    const token = signToken(user._id);

    const cookieOptions = {
        expires: new Date(
            Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
        ),
        httpOnly: true, // this will make the cookie cannot be accessed or modified in any way by the browser
        secure: req.secure || req.headers('x-forwarded-proto') === 'https',
    };

    // if (process.env.NODE_ENV === 'production') cookieOptions.secure = true; // cookie will only be sent on an encrypted connection.(Like https)

    // res.cookie('jwt', token, cookieOptions);

    user.password = undefined;

    res.status(statusCode).json({
        status: 'success',
        token,
        data: {
            user,
        },
    });
};

exports.signup = catchAsync(async (req, res, next) => {
    const newUser = await User.create({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        passwordConfirm: req.body.passwordConfirm,
        passwordChangedAt: req.body.passwordChangedAt,
        role: req.body.role,
    });
    const url = `${req.rotocol}://${req.get('host')}/me`;
    //console.log(url);
    await new Email(newUser, url).sendWelcome();

    createSendToken(newUser, 201, req, res);
});

exports.login = catchAsync(async (req, res, next) => {
    const { email, password } = req.body;

    // 1) Check if email and password exist.
    if (!email || !password) {
        next(new AppError('Please provide email and password!', 400));
    }

    // 2) Check if user exists && password is correct
    const user = await User.findOne({ email }).select('+password'); // I want the field that is by default not selected so need to use plus and then the name of the field.

    // console.log(password, user.password);
    if (!user || !(await user.correctPassword(password, user.password))) {
        // to prevent the inability to query the password consistently due to the nonexistence of the user.
        return next(new AppError('Incorrect email or password.', 401));
    }

    // 3) If everything ok, send token to client.

    createSendToken(user, 200, req, res);
});

exports.logout = (req, res) => {
    // Give the browser a cookie with the exact same name as the JWT cookie, so as to override the JWT cookie and achieve logout.
    res.cookie('jwt', 'loggedout', {
        expires: new Date(Date.now() + 10 * 1000),
        httpOnly: true,
    });

    res.status(200).json({
        status: 'success',
    });
};

exports.protect = catchAsync(async (req, res, next) => {
    // 1) Getting token and check of it's there.
    let token;
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies.jwt) {
        token = req.cookies.jwt;
    }

    if (!token) {
        return next(
            new AppError(
                'you are not logged in! please log in to get access',
                401
            )
        );
    }
    // 2) Validation token.
    // the third argument will be a callbak function,
    // this callback is then gonna run as soon as the verification has been completed.
    // so you see that this 'verify' here is actually an asynchronous function.
    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

    // 3) Check if user still exists.
    const CurrentUser = await User.findById(decoded.id);
    if (!CurrentUser) {
        return next(
            new AppError(
                'The user belonging to this token does no longer exist.',
                401
            )
        );
    }

    // 4) Check if user changed password after the token was issued.
    if (CurrentUser.changedPasswordAfter(decoded.iat)) {
        return next(
            new AppError('Password changed. Please log in again!', 401)
        );
    }

    req.user = CurrentUser;
    res.locals.user = CurrentUser;
    next();
});

// Only for rendered pages, no errors!
exports.isLoggedIn = async (req, res, next) => {
    if (req.cookies.jwt) {
        try {
            // verify token
            const decoded = await promisify(jwt.verify)(
                req.cookies.jwt,
                process.env.JWT_SECRET
            );

            // 3) Check if user still exists.
            const CurrentUser = await User.findById(decoded.id);
            if (!CurrentUser) {
                return next();
            }

            // 4) Check if user changed password after the token was issued.
            if (CurrentUser.changedPasswordAfter(decoded.iat)) {
                return next();
            }

            // THERE IS A LOGGED IN USER
            // Each and every pug template will have access to res.locals and whatever we put there will then be a variable inside of these templates
            res.locals.user = CurrentUser;
            return next();
        } catch (err) {
            return next();
        }
    }
    next();
};

exports.restrictTo = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(
                new AppError(
                    'You do not have permission to perform this action',
                    403
                )
            );
        }

        next();
    };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
    // 1) Get user based on POSTed email
    const user = await User.findOne({ email: req.body.email });
    if (!user) {
        return next(
            new AppError('There is no user with that email address.', 404)
        );
    }

    // 2) Generate the random reset token
    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    // 3) Send it to user's email

    try {
        // await sendEmail({
        //     email: user.email,
        //     subject: 'Your password reset token (valid for 10 min)',
        //     message,
        // });
        const resetURL = `${req.protocol}://${req.get(
            'host'
        )}/api/v1/users/resetPassword/${resetToken}`;

        await new Email(user, resetURL).sendPasswordReset();

        res.status(200).json({
            status: 'success',
            message: 'Token sent to email!',
        });
    } catch (err) {
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });

        return next(
            new AppError(
                'There was an error sending the email. Try again later!'
            ),
            500
        );
    }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
    // 1）Get user based on the token.

    // 这里的token是“router.patch('/resetPassword/:token', authController.resetPassword);”中的‘/:token’。
    const hashedToken = crypto
        .createHash('sha256')
        .update(req.params.token)
        .digest('hex');

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() },
    });

    // 2) If token has not expired, and there is a user,set the new password.

    if (!user) {
        return next(new AppError('Token is invaild or has expired', 400));
    }
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    // 3) Update changedPasswordAt property for the user

    // 4) Log the user in, send JWT.

    createSendToken(user, 200, req, res);
});

exports.updatePassword = catchAsync(async (req, res, next) => {
    // 1) Get user from collection.
    //console.log(1, req.body.currentPassword);
    const email = req.body.email;
    const user = await User.findById(req.user.id).select('+password');
    //console.log(1, user);
    // 2) Check if POSTed current password is correct.
    if (
        !user ||
        !(await user.correctPassword(req.body.currentPassword, user.password))
    ) {
        // console.log(1);
        return next(
            new AppError('Your current password Password is Wrong!', 401)
        );
    }

    // 3) If so,update password.
    user.password = req.body.newPassword;
    user.passwordConfirm = req.body.passwordConfirm;
    await user.save();

    // 4) Log user in, send JWT.
    createSendToken(user, 200, req, res);
});
