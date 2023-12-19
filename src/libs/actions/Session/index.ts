import throttle from 'lodash/throttle';
import {ChannelAuthorizationData} from 'pusher-js/types/src/core/auth/options';
import {ChannelAuthorizationCallback} from 'pusher-js/with-encryption';
import {Linking} from 'react-native';
import Onyx, {OnyxUpdate} from 'react-native-onyx';
import {ValueOf} from 'type-fest';
import * as API from '@libs/API';
import * as Authentication from '@libs/Authentication';
import * as ErrorUtils from '@libs/ErrorUtils';
import Log from '@libs/Log';
import Navigation from '@libs/Navigation/Navigation';
import * as NetworkStore from '@libs/Network/NetworkStore';
import * as Pusher from '@libs/Pusher/pusher';
import * as ReportUtils from '@libs/ReportUtils';
import Timers from '@libs/Timers';
import {hideContextMenu} from '@pages/home/report/ContextMenu/ReportActionContextMenu';
import * as Device from '@userActions/Device';
import * as PriorityMode from '@userActions/PriorityMode';
import redirectToSignIn from '@userActions/SignInRedirect';
import Timing from '@userActions/Timing';
import * as Welcome from '@userActions/Welcome';
import CONFIG from '@src/CONFIG';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import Credentials from '@src/types/onyx/Credentials';
import {AutoAuthState} from '@src/types/onyx/Session';
import clearCache from './clearCache';

let sessionAuthTokenType: string | null = '';
let sessionAuthToken: string | null = null;
let authPromiseResolver: ((value: boolean) => void) | null = null;

Onyx.connect({
    key: ONYXKEYS.SESSION,
    callback: (session) => {
        sessionAuthTokenType = session?.authTokenType ?? null;
        sessionAuthToken = session?.authToken ?? null;

        if (sessionAuthToken && authPromiseResolver) {
            authPromiseResolver(true);
            authPromiseResolver = null;
        }
    },
});

let credentials: Credentials = {};
Onyx.connect({
    key: ONYXKEYS.CREDENTIALS,
    callback: (value) => (credentials = value ?? {}),
});

let preferredLocale: ValueOf<typeof CONST.LOCALES> | null = null;
Onyx.connect({
    key: ONYXKEYS.NVP_PREFERRED_LOCALE,
    callback: (val) => (preferredLocale = val),
});

/**
 * Clears the Onyx store and redirects user to the sign in page
 */
function signOut() {
    Log.info('Flushing logs before signing out', true, {}, true);

    type LogOutParams = {
        authToken: string | null;
        partnerUserID: string;
        partnerName: string;
        partnerPassword: string;
        shouldRetry: boolean;
    };

    const params: LogOutParams = {
        // Send current authToken because we will immediately clear it once triggering this command
        authToken: NetworkStore.getAuthToken(),
        partnerUserID: credentials?.autoGeneratedLogin ?? '',
        partnerName: CONFIG.EXPENSIFY.PARTNER_NAME,
        partnerPassword: CONFIG.EXPENSIFY.PARTNER_PASSWORD,
        shouldRetry: false,
    };

    API.write('LogOut', params);
    clearCache().then(() => {
        Log.info('Cleared all cache data', true, {}, true);
    });
    Timing.clearData();
}

/**
 * Checks if the account is an anonymous account.
 */
function isAnonymousUser(): boolean {
    return sessionAuthTokenType === 'anonymousAccount';
}

function signOutAndRedirectToSignIn() {
    Log.info('Redirecting to Sign In because signOut() was called');
    hideContextMenu(false);
    if (!isAnonymousUser()) {
        signOut();
        redirectToSignIn();
    } else {
        if (Navigation.isActiveRoute(ROUTES.SIGN_IN_MODAL)) {
            return;
        }
        Navigation.navigate(ROUTES.SIGN_IN_MODAL);
        Linking.getInitialURL().then((url) => {
            const reportID = ReportUtils.getReportIDFromLink(url);
            if (reportID) {
                Onyx.merge(ONYXKEYS.LAST_OPENED_PUBLIC_ROOM_ID, reportID);
            }
        });
    }
}

/**
 * @param callback The callback to execute if the action is allowed
 * @param isAnonymousAction The action is allowed for anonymous or not
 * @returns same callback if the action is allowed, otherwise a function that signs out and redirects to sign in
 */
function checkIfActionIsAllowed<TCallback extends (...args: unknown[]) => unknown>(callback: TCallback, isAnonymousAction = false): TCallback | (() => void) {
    if (isAnonymousUser() && !isAnonymousAction) {
        return () => signOutAndRedirectToSignIn();
    }
    return callback;
}

/**
 * Resend the validation link to the user that is validating their account
 */
function resendValidationLink(login = credentials.login) {
    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: true,
                errors: null,
                message: null,
                loadingForm: CONST.FORMS.RESEND_VALIDATION_FORM,
            },
        },
    ];
    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                message: 'resendValidationForm.linkHasBeenResent',
                loadingForm: null,
            },
        },
    ];
    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                message: null,
                loadingForm: null,
            },
        },
    ];

    type ResendValidationLinkParams = {
        email?: string;
    };

    const params: ResendValidationLinkParams = {email: login};

    API.write('RequestAccountValidationLink', params, {optimisticData, successData, failureData});
}

/**
 * Request a new validate / magic code for user to sign in via passwordless flow
 */
function resendValidateCode(login = credentials.login) {
    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                errors: null,
                loadingForm: CONST.FORMS.RESEND_VALIDATE_CODE_FORM,
            },
        },
    ];
    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                loadingForm: null,
            },
        },
    ];
    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                loadingForm: null,
            },
        },
    ];

    type RequestNewValidateCodeParams = {
        email?: string;
    };

    const params: RequestNewValidateCodeParams = {email: login};

    API.write('RequestNewValidateCode', params, {optimisticData, successData, failureData});
}

type OnyxData = {
    optimisticData: OnyxUpdate[];
    successData: OnyxUpdate[];
    failureData: OnyxUpdate[];
};

/**
 * Constructs the state object for the BeginSignIn && BeginAppleSignIn API calls.
 */
function signInAttemptState(): OnyxData {
    return {
        optimisticData: [
            {
                onyxMethod: Onyx.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    ...CONST.DEFAULT_ACCOUNT_DATA,
                    isLoading: true,
                    message: null,
                    loadingForm: CONST.FORMS.LOGIN_FORM,
                },
            },
        ],
        successData: [
            {
                onyxMethod: Onyx.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    isLoading: false,
                    loadingForm: null,
                },
            },
            {
                onyxMethod: Onyx.METHOD.MERGE,
                key: ONYXKEYS.CREDENTIALS,
                value: {
                    validateCode: null,
                },
            },
        ],
        failureData: [
            {
                onyxMethod: Onyx.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    isLoading: false,
                    loadingForm: null,
                    errors: ErrorUtils.getMicroSecondOnyxError('loginForm.cannotGetAccountDetails'),
                },
            },
        ],
    };
}

/**
 * Checks the API to see if an account exists for the given login.
 */
function beginSignIn(email: string) {
    const {optimisticData, successData, failureData} = signInAttemptState();

    type BeginSignInParams = {
        email: string;
    };

    const params: BeginSignInParams = {email};

    API.read('BeginSignIn', params, {optimisticData, successData, failureData});
}

/**
 * Given an idToken from Sign in with Apple, checks the API to see if an account
 * exists for that email address and signs the user in if so.
 */
function beginAppleSignIn(idToken: string) {
    const {optimisticData, successData, failureData} = signInAttemptState();

    type BeginAppleSignInParams = {
        idToken: string;
        preferredLocale: ValueOf<typeof CONST.LOCALES> | null;
    };

    const params: BeginAppleSignInParams = {idToken, preferredLocale};

    API.write('SignInWithApple', params, {optimisticData, successData, failureData});
}

/**
 * Shows Google sign-in process, and if an auth token is successfully obtained,
 * passes the token on to the Expensify API to sign in with
 */
function beginGoogleSignIn(token: string) {
    const {optimisticData, successData, failureData} = signInAttemptState();

    type BeginGoogleSignInParams = {
        token: string;
        preferredLocale: ValueOf<typeof CONST.LOCALES> | null;
    };

    const params: BeginGoogleSignInParams = {token, preferredLocale};

    API.write('SignInWithGoogle', params, {optimisticData, successData, failureData});
}

/**
 * Will create a temporary login for the user in the passed authenticate response which is used when
 * re-authenticating after an authToken expires.
 */
function signInWithShortLivedAuthToken(email: string, authToken: string) {
    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
            },
        },
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    // If the user is signing in with a different account from the current app, should not pass the auto-generated login as it may be tied to the old account.
    // scene 1: the user is transitioning to newDot from a different account on oldDot.
    // scene 2: the user is transitioning to desktop app from a different account on web app.
    const oldPartnerUserID = credentials.login === email && credentials.autoGeneratedLogin ? credentials.autoGeneratedLogin : '';

    type SignInWithShortLivedAuthTokenParams = {
        authToken: string;
        oldPartnerUserID: string;
        skipReauthentication: boolean;
    };

    const params: SignInWithShortLivedAuthTokenParams = {authToken, oldPartnerUserID, skipReauthentication: true};

    API.read('SignInWithShortLivedAuthToken', params, {optimisticData, successData, failureData});
}

/**
 * Sign the user into the application. This will first authenticate their account
 * then it will create a temporary login for them which is used when re-authenticating
 * after an authToken expires.
 *
 * @param validateCode - 6 digit code required for login
 */
function signIn(validateCode: string, twoFactorAuthCode?: string) {
    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
                loadingForm: twoFactorAuthCode ? CONST.FORMS.VALIDATE_TFA_CODE_FORM : CONST.FORMS.VALIDATE_CODE_FORM,
            },
        },
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                loadingForm: null,
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.CREDENTIALS,
            value: {
                validateCode,
            },
        },
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                loadingForm: null,
            },
        },
    ];

    Device.getDeviceInfoWithID().then((deviceInfo) => {
        type SignInUserParams = {
            twoFactorAuthCode?: string;
            email?: string;
            preferredLocale: ValueOf<typeof CONST.LOCALES> | null;
            validateCode?: string;
            deviceInfo: string;
        };

        const params: SignInUserParams = {
            twoFactorAuthCode,
            email: credentials.login,
            preferredLocale,
            deviceInfo,
        };

        // Conditionally pass a password or validateCode to command since we temporarily allow both flows
        if (validateCode || twoFactorAuthCode) {
            params.validateCode = validateCode || credentials.validateCode;
        }

        API.write('SigninUser', params, {optimisticData, successData, failureData});
    });
}

function signInWithValidateCode(accountID: number, code: string, twoFactorAuthCode = '') {
    // If this is called from the 2fa step, get the validateCode directly from onyx
    // instead of the one passed from the component state because the state is changing when this method is called.
    const validateCode = twoFactorAuthCode ? credentials.validateCode : code;

    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
                loadingForm: twoFactorAuthCode ? CONST.FORMS.VALIDATE_TFA_CODE_FORM : CONST.FORMS.VALIDATE_CODE_FORM,
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.SESSION,
            value: {autoAuthState: CONST.AUTO_AUTH_STATE.SIGNING_IN},
        },
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                loadingForm: null,
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.CREDENTIALS,
            value: {
                accountID,
                validateCode,
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.SESSION,
            value: {autoAuthState: CONST.AUTO_AUTH_STATE.JUST_SIGNED_IN},
        },
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                loadingForm: null,
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.SESSION,
            value: {autoAuthState: CONST.AUTO_AUTH_STATE.FAILED},
        },
    ];
    Device.getDeviceInfoWithID().then((deviceInfo) => {
        type SignInUserWithLinkParams = {
            accountID: number;
            validateCode?: string;
            twoFactorAuthCode?: string;
            preferredLocale: ValueOf<typeof CONST.LOCALES> | null;
            deviceInfo: string;
        };

        const params: SignInUserWithLinkParams = {
            accountID,
            validateCode,
            twoFactorAuthCode,
            preferredLocale,
            deviceInfo,
        };

        API.write('SigninUserWithLink', params, {optimisticData, successData, failureData});
    });
}

function signInWithValidateCodeAndNavigate(accountID: number, validateCode: string, twoFactorAuthCode = '') {
    signInWithValidateCode(accountID, validateCode, twoFactorAuthCode);
    Navigation.navigate(ROUTES.HOME);
}

/**
 * Initializes the state of the automatic authentication when the user clicks on a magic link.
 *
 * This method is called in componentDidMount event of the lifecycle.
 * When the user gets authenticated, the component is unmounted and then remounted
 * when AppNavigator switches from PublicScreens to AuthScreens.
 * That's the reason why autoAuthState initialization is skipped while the last state is SIGNING_IN.
 */
function initAutoAuthState(cachedAutoAuthState: AutoAuthState) {
    const signedInStates: AutoAuthState[] = [CONST.AUTO_AUTH_STATE.SIGNING_IN, CONST.AUTO_AUTH_STATE.JUST_SIGNED_IN];

    Onyx.merge(ONYXKEYS.SESSION, {
        autoAuthState: signedInStates.includes(cachedAutoAuthState) ? CONST.AUTO_AUTH_STATE.JUST_SIGNED_IN : CONST.AUTO_AUTH_STATE.NOT_STARTED,
    });
}

function invalidateCredentials() {
    Onyx.merge(ONYXKEYS.CREDENTIALS, {autoGeneratedLogin: '', autoGeneratedPassword: ''});
}

function invalidateAuthToken() {
    NetworkStore.setAuthToken('pizza');
    Onyx.merge(ONYXKEYS.SESSION, {authToken: 'pizza'});
}

/**
 * Sets the SupportToken
 */
function setSupportAuthToken(supportAuthToken: string, email: string, accountID: number) {
    if (supportAuthToken) {
        Onyx.merge(ONYXKEYS.SESSION, {
            authToken: '1',
            supportAuthToken,
            email,
            accountID,
        });
    } else {
        Onyx.set(ONYXKEYS.SESSION, {});
    }
    NetworkStore.setSupportAuthToken(supportAuthToken);
}

/**
 * Clear the credentials and partial sign in session so the user can taken back to first Login step
 */
function clearSignInData() {
    Onyx.multiSet({
        [ONYXKEYS.ACCOUNT]: null,
        [ONYXKEYS.CREDENTIALS]: null,
    });
}

/**
 * Put any logic that needs to run when we are signed out here. This can be triggered when the current tab or another tab signs out.
 */
function cleanupSession() {
    Pusher.disconnect();
    Timers.clearAll();
    Welcome.resetReadyCheck();
    PriorityMode.resetHasReadRequiredDataFromStorage();
}

function clearAccountMessages() {
    Onyx.merge(ONYXKEYS.ACCOUNT, {
        success: '',
        errors: null,
        message: null,
        isLoading: false,
    });
}

function setAccountError(error: string) {
    Onyx.merge(ONYXKEYS.ACCOUNT, {errors: ErrorUtils.getMicroSecondOnyxError(error)});
}

// It's necessary to throttle requests to reauthenticate since calling this multiple times will cause Pusher to
// reconnect each time when we only need to reconnect once. This way, if an authToken is expired and we try to
// subscribe to a bunch of channels at once we will only reauthenticate and force reconnect Pusher once.
const reauthenticatePusher = throttle(
    () => {
        Log.info('[Pusher] Re-authenticating and then reconnecting');
        Authentication.reauthenticate('AuthenticatePusher')
            .then(Pusher.reconnect)
            .catch(() => {
                console.debug('[PusherConnectionManager]', 'Unable to re-authenticate Pusher because we are offline.');
            });
    },
    5000,
    {trailing: false},
);

function authenticatePusher(socketID: string, channelName: string, callback: ChannelAuthorizationCallback) {
    Log.info('[PusherAuthorizer] Attempting to authorize Pusher', false, {channelName});

    type AuthenticatePusherParams = {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        socket_id: string;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        channel_name: string;
        shouldRetry: boolean;
        forceNetworkRequest: boolean;
    };

    const params: AuthenticatePusherParams = {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        socket_id: socketID,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        channel_name: channelName,
        shouldRetry: false,
        forceNetworkRequest: true,
    };

    // We use makeRequestWithSideEffects here because we need to authorize to Pusher (an external service) each time a user connects to any channel.
    // eslint-disable-next-line rulesdir/no-api-side-effects-method
    API.makeRequestWithSideEffects('AuthenticatePusher', params)
        .then((response) => {
            if (response?.jsonCode === CONST.JSON_CODE.NOT_AUTHENTICATED) {
                Log.hmmm('[PusherAuthorizer] Unable to authenticate Pusher because authToken is expired');
                callback(new Error('Pusher failed to authenticate because authToken is expired'), {auth: ''});

                // Attempt to refresh the authToken then reconnect to Pusher
                reauthenticatePusher();
                return;
            }

            if (response?.jsonCode !== CONST.JSON_CODE.SUCCESS) {
                Log.hmmm('[PusherAuthorizer] Unable to authenticate Pusher for reason other than expired session');
                callback(new Error(`Pusher failed to authenticate because code: ${response?.jsonCode} message: ${response?.message}`), {auth: ''});
                return;
            }

            Log.info('[PusherAuthorizer] Pusher authenticated successfully', false, {channelName});
            callback(null, response as ChannelAuthorizationData);
        })
        .catch((error) => {
            Log.hmmm('[PusherAuthorizer] Unhandled error: ', {channelName, error});
            callback(new Error('AuthenticatePusher request failed'), {auth: ''});
        });
}

/**
 * Request a new validation link / magic code to unlink an unvalidated secondary login from a primary login
 */
function requestUnlinkValidationLink() {
    const optimisticData = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: true,
                errors: null,
                message: null,
                loadingForm: CONST.FORMS.UNLINK_LOGIN_FORM,
            },
        },
    ];
    const successData = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                message: 'unlinkLoginForm.linkSent',
                loadingForm: null,
            },
        },
    ];
    const failureData = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                loadingForm: null,
            },
        },
    ];

    type RequestUnlinkValidationLinkParams = {
        email?: string;
    };

    const params: RequestUnlinkValidationLinkParams = {email: credentials.login};

    API.write('RequestUnlinkValidationLink', params, {optimisticData, successData, failureData});
}

function unlinkLogin(accountID: number, validateCode: string) {
    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
            },
        },
    ];
    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                message: 'unlinkLoginForm.succesfullyUnlinkedLogin',
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.CREDENTIALS,
            value: {
                login: '',
            },
        },
    ];
    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    type UnlinkLoginParams = {
        accountID: number;
        validateCode: string;
    };

    const params: UnlinkLoginParams = {
        accountID,
        validateCode,
    };

    API.write('UnlinkLogin', params, {
        optimisticData,
        successData,
        failureData,
    });
}

/**
 * Toggles two-factor authentication based on the `enable` parameter
 */
function toggleTwoFactorAuth(enable: boolean) {
    const optimisticData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: true,
            },
        },
    ];

    const successData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    const failureData: OnyxUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    API.write(enable ? 'EnableTwoFactorAuth' : 'DisableTwoFactorAuth', {}, {optimisticData, successData, failureData});
}

function validateTwoFactorAuth(twoFactorAuthCode: string) {
    const optimisticData = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: true,
            },
        },
    ];

    const successData = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    const failureData = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    type ValidateTwoFactorAuthParams = {
        twoFactorAuthCode: string;
    };

    const params: ValidateTwoFactorAuthParams = {twoFactorAuthCode};

    API.write('TwoFactorAuth_Validate', params, {optimisticData, successData, failureData});
}

/**
 * Waits for a user to sign in.
 *
 * If the user is already signed in (`authToken` is truthy), the promise resolves immediately.
 * Otherwise, the promise will resolve when the `authToken` in `ONYXKEYS.SESSION` becomes truthy via the Onyx callback.
 * The promise will not reject on failed login attempt.
 *
 * @returns A promise that resolves to `true` once the user is signed in.
 * @example
 * waitForUserSignIn().then(() => {
 *   console.log('User is signed in!');
 * });
 */
function waitForUserSignIn(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        if (sessionAuthToken) {
            resolve(true);
        } else {
            authPromiseResolver = resolve;
        }
    });
}

/**
 * check if the route can be accessed by anonymous user
 *
 * @param {string} route
 */

const canAccessRouteByAnonymousUser = (route: string) => {
    const reportID = ReportUtils.getReportIDFromLink(route);
    if (reportID) {
        return true;
    }
    const parsedReportRouteParams = ReportUtils.parseReportRouteParams(route);
    let routeRemovedReportId = route;
    if ((parsedReportRouteParams as {reportID: string})?.reportID) {
        routeRemovedReportId = route.replace((parsedReportRouteParams as {reportID: string})?.reportID, ':reportID');
    }
    if (route.startsWith('/')) {
        routeRemovedReportId = routeRemovedReportId.slice(1);
    }
    const routesCanAccessByAnonymousUser = [ROUTES.SIGN_IN_MODAL, ROUTES.REPORT_WITH_ID_DETAILS.route, ROUTES.REPORT_WITH_ID_DETAILS_SHARE_CODE.route];

    if ((routesCanAccessByAnonymousUser as string[]).includes(routeRemovedReportId)) {
        return true;
    }
    return false;
};

/**
 * set the last shown splash screen video
 *
 * @param {string} name
 */

const setLastShownSplashScreenVideo = (name: string) => {
    Onyx.merge(ONYXKEYS.LAST_SHOWN_SPLASH_VIDEO, name);
};

export {
    beginSignIn,
    beginAppleSignIn,
    beginGoogleSignIn,
    setSupportAuthToken,
    checkIfActionIsAllowed,
    signIn,
    signInWithValidateCode,
    signInWithValidateCodeAndNavigate,
    initAutoAuthState,
    signInWithShortLivedAuthToken,
    cleanupSession,
    signOut,
    signOutAndRedirectToSignIn,
    resendValidationLink,
    resendValidateCode,
    requestUnlinkValidationLink,
    unlinkLogin,
    clearSignInData,
    clearAccountMessages,
    setAccountError,
    authenticatePusher,
    reauthenticatePusher,
    invalidateCredentials,
    invalidateAuthToken,
    isAnonymousUser,
    toggleTwoFactorAuth,
    validateTwoFactorAuth,
    waitForUserSignIn,
    canAccessRouteByAnonymousUser,
    setLastShownSplashScreenVideo,
};
