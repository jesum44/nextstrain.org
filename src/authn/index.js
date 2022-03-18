// Server handlers for authentication (authn).  Authorization (authz) is done
// in the server's charon handlers.
//
const querystring = require("querystring");
const session = require("express-session");
const Redis = require("ioredis");
const RedisStore = require("connect-redis")(session);
const FileStore = require("session-file-store")(session);
const passport = require("passport");
const OAuth2Strategy = require("passport-oauth2").Strategy;
const {jwtVerify} = require('jose/jwt/verify');                   // eslint-disable-line import/no-unresolved
const {createRemoteJWKSet} = require('jose/jwks/remote');         // eslint-disable-line import/no-unresolved
const {JOSEError, JWTClaimValidationFailed} = require('jose/util/errors');   // eslint-disable-line import/no-unresolved
const BearerStrategy = require("./bearer");
const utils = require("../utils");

const PRODUCTION = process.env.NODE_ENV === "production";

const SESSION_SECRET = PRODUCTION
  ? process.env.SESSION_SECRET
  : "BAD SECRET FOR DEV ONLY";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30d in seconds

/* Our heroku apps (nextstrain-dev & nextstrain-server) set the `REDIS_URL` env variable */
const REDIS_URL = process.env.REDIS_URL;

const COGNITO_USER_POOL_ID = "us-east-1_Cg5rcTged";

const COGNITO_REGION = COGNITO_USER_POOL_ID.split("_")[0];

const COGNITO_USER_POOL_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`;

const COGNITO_JWKS = createRemoteJWKSet(new URL(`${COGNITO_USER_POOL_URL}/.well-known/jwks.json`));

const COGNITO_BASE_URL = "https://login.nextstrain.org";

const COGNITO_CLIENT_ID = PRODUCTION
  ? "rki99ml8g2jb9sm1qcq9oi5n"    // prod client limited to nextstrain.org (and next. and dev.)
  : "6q7cmj0ukti9d9kdkqi2dfvh7o"; // dev client limited to localhost

/* Registered clients to accept for Bearer tokens.
 *
 * In the future, we could opt to pull this list dynamically from Cognito at
 * server start and might want to if we start having third-party clients, but
 * avoid a start-time dep for now.
 */
const BEARER_COGNITO_CLIENT_IDS = [
  "2vmc93kj4fiul8uv40uqge93m5",   // Nextstrain CLI
];

/* Arbitrary ids for the various strategies for Passport.  Makes explicit the
 * implicit defaults; uses constants instead of string literals for better
 * grepping, linting, and less magic; would be an enum if JS had them (or we
 * had TypeScript).
 */
const STRATEGY_OAUTH2 = "oauth2";
const STRATEGY_BEARER = "bearer";

/* Flag indicating that the user object was updated during deserialization from
 * an existing session and that it needs to be resaved back to the session.
 */
const RESAVE_TO_SESSION = Symbol("RESAVE_TO_SESSION");

function setup(app) {
  passport.use(
    STRATEGY_OAUTH2,
    new OAuth2Strategy(
      {
        authorizationURL: `${COGNITO_BASE_URL}/oauth2/authorize`,
        tokenURL: `${COGNITO_BASE_URL}/oauth2/token`,
        clientID: COGNITO_CLIENT_ID,
        callbackURL: "/logged-in",
        pkce: true,
        state: true
      },
      async (accessToken, refreshToken, {id_token: idToken}, profile, done) => {
        // Verify both tokens for good measure, but pull user information from
        // the identity token (which is its intended purpose).
        try {
          await verifyToken(accessToken, "access");

          const user = await userFromIdToken(idToken);

          // All users are ok, as we control the entire user pool.
          return done(null, user);
        } catch (e) {
          return e instanceof JOSEError
            ? done(null, false, "Error verifying token")
            : done(e);
        }
      }
    )
  );

  passport.use(
    STRATEGY_BEARER,
    new BearerStrategy(
      {
        realm: "nextstrain.org",
        passIfMissing: true,
      },
      async (idToken, done) => {
        try {
          const user = await userFromIdToken(idToken, BEARER_COGNITO_CLIENT_IDS);
          return done(null, user);
        } catch (e) {
          return e instanceof JOSEError
            ? done(null, false, "Error verifying token")
            : done(e);
        }
      }
    )
  );

  // Serialize the entire user profile to the session store to avoid additional
  // requests to Cognito when we need to load back a user profile from their
  // session cookie.
  passport.serializeUser((user, done) => {
    let serializedUser = {...user}; // eslint-disable-line prefer-const

    // Deflate authzRoles from Set to Array
    if ("authzRoles" in serializedUser) {
      serializedUser.authzRoles = [...serializedUser.authzRoles];
    }

    return done(null, JSON.stringify(serializedUser));
  });

  passport.deserializeUser((serializedUser, done) => {
    let user = JSON.parse(serializedUser); // eslint-disable-line prefer-const

    // Inflate authzRoles from Array back into a Set
    if ("authzRoles" in user) {
      user.authzRoles = new Set(user.authzRoles);
    }

    /* Update existing sessions that pre-date the presence of authzRoles.  When
     * authzRoles is absent, "groups" is the unparsed set of Cognito groups.
     */
    if (!("authzRoles" in user)) {
      const {groups, authzRoles} = parseCognitoGroups(user.groups || []);
      utils.verbose(`Upgrading groups and authzRoles of user object for ${user.username}`);
      user.groups = groups;
      user.authzRoles = authzRoles;
      user[RESAVE_TO_SESSION] = true;
    }

    return done(null, user);
  });

  // Setup session storage and passport.
  const sessionStore = () => {
    if (REDIS_URL) {
      const url = new URL(REDIS_URL);

      // Heroku Redis' TLS socket is documented to be on the next port up.  The
      // scheme for secure redis:// URLs is rediss://.
      if (url.protocol === "redis:") {
        utils.verbose(`Rewriting Redis URL <${scrubUrl(url)}> to use TLS`);
        url.protocol = "rediss:";
        url.port = Number(url.port) + 1;
      }

      utils.verbose(`Storing sessions in Redis at <${scrubUrl(url)}>`);

      const client = new Redis(url.toString(), {
        tls: {
          // It is pretty frustrating that Heroku doesn't provide verifiable
          // certs.  Although we're not using the Heroku Redis buildpack, the
          // issue is documented here nicely
          // <https://github.com/heroku/heroku-buildpack-redis/issues/15>.
          rejectUnauthorized: false
        }
      });

      return new RedisStore({
        client,

        // Using a key prefix reduces the chance that we conflict with
        // potential future usage of Redis in this codebase.  While this is
        // very unlikely because the session keys are long random strings, I
        // like code to be defensive and future-proof.
        prefix: "nextstrain.org-session:",
        ttl: SESSION_MAX_AGE
      });
    }

    /* If no REDIS_URL is available, then we are running in a development
    environment and want to use a local FileStore to store the session.
    We limit the retries to 0 to avoid excessive warnings when the
    browser remembers a session id that is not on your filesystem */
    utils.verbose("Storing sessions as files under session/");
    return new FileStore({ttl: SESSION_MAX_AGE, retries: 0});
  };

  app.use(
    session({
      name: "nextstrain.org",
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      store: sessionStore(),
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: PRODUCTION,
        maxAge: SESSION_MAX_AGE * 1000 // milliseconds
      }
    })
  );

  app.use(passport.initialize());

  // If an Authorization header is present, then it must container a valid
  // Bearer token.  No session will be created for Bearer authn.
  //
  // If an Authorization header is not present, this authn strategy is
  // configured (above) to pass to the next request handler (user restoration
  // from session).
  app.use(passport.authenticate(STRATEGY_BEARER, { session: false }));

  // Restore user from the session, if any.  If no session, then req.user will
  // be null.
  app.use(passport.session());

  // If the user object was modified in deserializeUser during restore from the
  // session, then persist the modifications back into the session by updating
  // the user object in the session via req.login().  The session will detect
  // its been changed and save itself to the store at the end of the request.
  app.use((req, res, next) => {
    if (req.user?.[RESAVE_TO_SESSION]) {
      utils.verbose(`Resaving user object for ${req.user.username} back to the session`);
      delete req.user[RESAVE_TO_SESSION];
      return req.login(req.user, next);
    }
    return next();
  });

  // Set the app's origin centrally so other handlers can use it
  //
  // We can trust the HTTP Host header (req.hostname) because we're always
  // running behind name-based virtual hosting on Heroku.  A forged Host header
  // will be rejected by Heroku and never make it to us.
  app.use((req, res, next) => {
    res.locals.origin = PRODUCTION
      ? `${req.protocol}://${req.hostname}`
      : `${req.protocol}://${req.hostname}:${req.app.get("port")}`;
    next();
  });

  // Routes
  //
  // Authenticate with Cognito IdP on /login and establish a local session
  app.route("/login").get(
    (req, res, next) => {
      /* Save the original page the user was on with a best-effort approach.
       * If there is no Referer or it's not parseable as a URL, then ignore it
       * and we'll do the default thing of redirecting to the home page.
       *
       * Only use the Referer if it points to ourselves, so that our login flow
       * can't be abused to send folks to external sites.
       */
      try {
        const referer = new URL(req.header("Referer"));

        if (res.locals.origin === referer.origin) {
          req.session.afterLoginReturnTo = referer.pathname;
        }
      } catch (e) {
        // intentionally left empty
      }
      next();
    },
    passport.authenticate(STRATEGY_OAUTH2)
  );

  // Verify IdP response on /logged-in
  app.route("/logged-in").get(
    passport.authenticate(STRATEGY_OAUTH2, { failureRedirect: "/" }),
    (req, res) => {
      // We can trust this value from the session because we are the only ones
      // in control of it.
      res.redirect(req.session.afterLoginReturnTo || "/");
    }
  );

  // Delete our local session and redirect to logout from Cognito IdP
  app.route("/logout").get((req, res) => {
    req.session.destroy(() => {
      const params = {
        client_id: COGNITO_CLIENT_ID,
        logout_uri: res.locals.origin
      };
      res.redirect(`${COGNITO_BASE_URL}/logout?${querystring.stringify(params)}`);
    });
  });
}


/**
 * Creates a user record from the given `idToken` after verifying it.
 *
 * @param {String} idToken
 * @param {String|String[]} client. Optional. Passed to `verifyToken()`.
 * @returns {User} User record with e.g. `username` and `groups` keys.
 */
async function userFromIdToken(idToken, client = undefined) {
  const idClaims = await verifyToken(idToken, "id", client);

  const {groups, authzRoles} = parseCognitoGroups(idClaims["cognito:groups"] || []);

  const user = {
    username: idClaims["cognito:username"],
    groups,
    authzRoles,
  };
  return user;
}

/**
 * Parse an array of Cognito groups into a user's Nextstrain groups and their
 * authzRoles.
 *
 * @returns {object} result
 * @returns {string[]} result.groups - Names of the Nextstrain Groups of which this user is a member.
 * @returns {Set} result.authzRoles - Authorization roles granted to this user.
 */
function parseCognitoGroups(cognitoGroups) {
  return {
    // Just the Nextstrain Group names, which for now means all Cognito groups
    // (excluding an optional "/role" suffix).
    groups: [...new Set(cognitoGroups.map(g => splitGroupRole(g).group))],

    /* During a transition period while we move users from unsuffixed Cognito
     * groups to role-suffixed Cognito groups, assume the least privileged
     * Nextstrain Group role (viewer) for each unsuffixed group membership we
     * find.  This matches the existing capabilities via nextstrain.org before
     * the existence of group membership roles.
     *
     * XXX TODO: Remove this .map(...) immediately after the transition period
     * is over.
     *   -trs, 5 Jan 2022
     *
     * This now only applies to existing sessions established before 4 March
     * 2022, as the behind-the-scenes migration of Cognito groups is complete.
     * In order to remove the .map(...) we'll need to log every one out by
     * invalidating all such sessions or wait for such sessions to gradually
     * decay and naturally expire.
     *   -trs, 4 Mar 2022
     */
    authzRoles: new Set(cognitoGroups.map(g => g.includes("/") ? g : `${g}/viewers`)),
  };
}

/**
 * User object.
 *
 * @typedef User
 * @type {object}
 * @property {string} username
 * @property {string[]} groups - Names of the Nextstrain Groups of which this user is a member.
 * @property {Set} authzRoles - Authorization roles granted to this user.
 */


function splitGroupRole(cognitoGroup) {
  // I wish split("/", 1) worked reasonably.  -trs, 20 Dec 2021
  const [group, ...rest] = cognitoGroup.split("/");
  return {group, role: rest.join("/")};
}


/**
 * Verifies all aspects of the given `token` (a signed JWT from our AWS Cognito
 * user pool) which is expected to be used for the given `use`.
 *
 * Assertions about expected algorithms, audience, issuer, and token use follow
 * guidelines from
 * <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html>.
 *
 * @param {String} token
 * @param {String} use
 * @param {String} client. Optional `client_id` or list of `client_id`s
 *                 expected for the token. Only relevant when `use` is not
 *                 `access`. Defaults to this server's client id.
 * @returns {Object} Verified claims from the token's payload
 */
async function verifyToken(token, use, client = COGNITO_CLIENT_ID) {
  const {payload: claims} = await jwtVerify(token, COGNITO_JWKS, {
    algorithms: ["RS256"],
    issuer: COGNITO_USER_POOL_URL,
    audience: use !== "access" ? client : null,
  });

  const claimedUse = claims["token_use"];

  if (claimedUse !== use) {
    throw new JWTClaimValidationFailed(`unexpected "token_use" claim value: ${claimedUse}`, "token_use", "check_failed");
  }

  return claims;
}

function scrubUrl(url) {
  const scrubbedUrl = new URL(url);
  scrubbedUrl.password = "XXXXXX";
  return scrubbedUrl;
}

module.exports = {
  setup
};
