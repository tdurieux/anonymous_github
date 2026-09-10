import { createClient } from "redis";
import * as passport from "passport";
import * as session from "express-session";
import RedisStore from "connect-redis";
import * as OAuth2Strategy from "passport-oauth2";
import { Profile, Strategy } from "passport-github2";
import * as express from "express";

import config from "../../config";
import UserModel from "../../core/model/users/users.model";
import { IUserDocument } from "../../core/model/users/users.types";
import AnonymousError from "../../core/AnonymousError";
import { setCredential } from "../../core/credentials";
import { hashToken } from "./token-auth";
import { createLogger, serializeError } from "../../core/logger";
import { getLoginToken, isDisabledAccount, safeAuthReturnTo } from "./auth-utils";

const logger = createLogger("auth");

export function ensureAuthenticated(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: "not_connected" });
}

export const verify = async (
  req: express.Request,
  accessToken: string,
  _refreshToken: string,
  profile: Profile,
  done: OAuth2Strategy.VerifyCallback
): Promise<void> => {
  let user: IUserDocument | null;
  try {
    const flow = req.githubOAuthContext;
    const currentId = (req.user as { user?: { id?: string } } | undefined)?.user?.id;
    if (!flow || flow.expires < Date.now() || (flow.githubId && flow.githubId !== profile.id)
      || (currentId && currentId !== flow.ownerId)) {
      done(new AnonymousError("github_identity_mismatch", { httpStatus: 409 }));
      return;
    }
    user = await UserModel.findOne({ "externalIDs.github": profile.id });
    if (user) {
      if (flow.ownerId && user.id !== flow.ownerId) {
        done(new AnonymousError("github_identity_mismatch", { httpStatus: 409 }));
        return;
      }
      if (isDisabledAccount(user.status)) {
        done(
          new AnonymousError(
            user.status === "banned" ? "user_banned" : "not_connected",
            { httpStatus: user.status === "banned" ? 403 : 401 }
          )
        );
        return;
      }
    } else {
      // Check if a user with this username already exists (e.g. created
      // manually without externalIDs.github). Link the GitHub ID to the
      // existing account instead of creating a duplicate that would lose
      // the isAdmin flag.
      user = await UserModel.findOne({ username: profile.username });
      if (flow.ownerId && (!user || user.id !== flow.ownerId)) {
        done(new AnonymousError("github_identity_mismatch", { httpStatus: 409 }));
        return;
      }
      if (user) {
        if (user.externalIDs?.github && user.externalIDs.github !== profile.id) {
          done(new AnonymousError("not_connected", { httpStatus: 401 }));
          return;
        }
        if (isDisabledAccount(user.status)) {
          done(
            new AnonymousError(
              user.status === "banned" ? "user_banned" : "not_connected",
              { httpStatus: user.status === "banned" ? 403 : 401 }
            )
          );
          return;
        }
        await UserModel.updateOne(
          { _id: user._id },
          {
            $set: {
              "externalIDs.github": profile.id,
            },
          }
        );
        user = await UserModel.findById(user._id);
      } else {
        const photo = profile.photos ? profile.photos[0]?.value : null;
        user = new UserModel({
          username: profile.username,
          externalIDs: {
            github: profile.id,
          },
          emails: profile.emails?.map((email) => {
            return { email: email.value, default: false };
          }),
          photo,
        });
        if (user.emails?.length) user.emails[0].default = true;
        await user.save();
      }
    }
    if (isDisabledAccount(user!.status)) {
      done(
        new AnonymousError(
          user!.status === "banned" ? "user_banned" : "not_connected",
          {
            httpStatus: user!.status === "banned" ? 403 : 401,
          }
        )
      );
      return;
    }
    await setCredential(String(user!._id), accessToken);
    done(null, { username: user!.username, user });
  } catch (error) {
    logger.error("verify failed", serializeError(error));
    done(
      new AnonymousError("unable_to_connect_user", {
        httpStatus: 500,
        object: profile,
        cause: error as Error,
      })
    );
  }
};

if (config.GITHUB_OAUTH_ENABLED) passport.use(
  new Strategy(
    {
      passReqToCallback: true,
      clientID: config.CLIENT_ID,
      clientSecret: config.CLIENT_SECRET,
      callbackURL: config.AUTH_CALLBACK,
      // passport-oauth2 supports boolean session state; github2 types incorrectly narrow it.
      state: true as unknown as string,
    },
    verify
  )
);

passport.serializeUser((user: Express.User, done) => {
  const id = (user as { user?: { _id?: unknown } }).user?._id;
  done(null, String(id));
});

passport.deserializeUser(async (id: string, done) => {
  // Reject the old session format, which included plaintext credentials.
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) return done(null, false);
  try {
    const user = await UserModel.findById(id);
    if (!user || isDisabledAccount(user.status)) return done(null, false);
    done(null, { username: user.username, user });
  } catch {
    done(new Error("Session user lookup failed"));
  }
});

export function initSession() {
  const redisClient = createClient({
    legacyMode: false,
    socket: {
      port: config.REDIS_PORT,
      host: config.REDIS_HOSTNAME,
    },
  });
  redisClient.on("error", (err) =>
    logger.error("redis client error", serializeError(err))
  );
  redisClient.connect();
  const redisStore = new RedisStore({
    client: redisClient,
    prefix: "anoGH_session:",
  });

  return session({
    secret: config.SESSION_SECRET,
    store: redisStore,
    saveUninitialized: false,
    resave: false,
  });
}

export const router = express.Router();

router.get("/account-recovery", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ required: !!req.session.githubRecovery && req.session.githubRecovery.expires > Date.now() });
});

router.get(
  "/login",
  (req, res, next) => config.GITHUB_OAUTH_ENABLED ? next() : res.status(503).json({ error: "github_oauth_disabled" }),
  (req, res, next) => {
    const recovery = req.query.recover === "1" ? req.session.githubRecovery : undefined;
    if (req.query.recover === "1" && (!recovery || recovery.expires < Date.now())) return res.redirect("/signin");
    const current = (req.user as { user?: IUserDocument } | undefined)?.user;
    req.session.githubOAuthFlow = recovery || { ownerId: current?.id, githubId: current?.externalIDs?.github,
      returnTo: safeAuthReturnTo(req.query.returnTo, current ? "/connections" : "/dashboard"), expires: Date.now() + 10 * 60000 };
    next();
  },
  passport.authenticate("github", { scope: ["repo"] }), // Note the scope here
  function (req: express.Request, res: express.Response) {
    res.redirect("/");
  }
);

router.get(
  "/auth",
  (req, res, next) => {
    if (!config.GITHUB_OAUTH_ENABLED) return res.status(503).json({ error: "github_oauth_disabled" });
    const flow = req.session.githubOAuthFlow;
    delete req.session.githubOAuthFlow;
    req.githubOAuthContext = flow;
    const existingId = (req.user as { user?: { id?: string } } | undefined)?.user?.id;
    passport.authenticate("github", (error: Error | null, identity: Express.User | false) => {
      if (error) return next(error);
      if (!identity) return res.redirect("/signin");
      const id = (identity as { user?: { id?: string } }).user?.id;
      if (existingId && id !== existingId) return res.status(409).json({ error: "github_identity_mismatch" });
      req.login(identity, loginError => {
        if (loginError) return next(loginError);
        if (flow?.recovery) {
          delete req.session.githubRecovery;
          return res.redirect("/github/app/login?returnTo=" + encodeURIComponent(flow.returnTo));
        }
        res.redirect(flow?.returnTo || (existingId ? "/connections" : "/dashboard"));
      });
    })(req, res, next);
  }
);

// Accept an API token and establish a session cookie so the web UI is
// reachable without going through GitHub OAuth. Keep credentials out of URLs,
// which are routinely retained in access logs and browser history.
router.post(
  "/login-token",
  async function (req: express.Request, res: express.Response) {
    const token = getLoginToken(req);
    if (!token) {
      return res.status(400).json({ error: "missing_token" });
    }
    try {
      const model = await UserModel.findOne({
        "apiTokens.tokenHash": hashToken(token),
      });
      if (!model) return res.status(401).json({ error: "invalid_token" });
      if (isDisabledAccount(model.status)) {
        return res.status(model.status === "banned" ? 403 : 401).json({
          error: model.status === "banned" ? "user_banned" : "not_connected",
        });
      }
      const synthUser = {
        username: model.username,
        profile: undefined,
        user: model,
      };
      req.login(synthUser, (err) => {
        if (err) {
          logger.error("login-token req.login failed", serializeError(err));
          return res.status(500).json({ error: "login_failed" });
        }
        UserModel.updateOne(
          { _id: model._id, "apiTokens.tokenHash": hashToken(token) },
          { $set: { "apiTokens.$.lastUsedAt": new Date() } }
        ).catch(() => undefined);
        return res.json({ ok: true, username: model.username });
      });
    } catch (err) {
      logger.error("login-token failed", serializeError(err));
      res.status(500).json({ error: "server_error" });
    }
  }
);
