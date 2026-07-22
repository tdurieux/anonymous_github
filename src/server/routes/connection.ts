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
import AnonymizedPullRequestModel from "../../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import { hashToken } from "./token-auth";
import { createLogger, serializeError } from "../../core/logger";
import { getLoginToken, isDisabledAccount } from "./auth-utils";

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

const verify = async (
  accessToken: string,
  refreshToken: string,
  profile: Profile,
  done: OAuth2Strategy.VerifyCallback
): Promise<void> => {
  let user: IUserDocument | null;
  try {
    const now = new Date();
    user = await UserModel.findOne({ "externalIDs.github": profile.id });
    if (user) {
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
            "accessTokens.github": accessToken,
            "accessTokenDates.github": now,
          },
        }
      );
      await AnonymizedPullRequestModel.updateMany(
        { owner: user._id },
        { "source.accessToken": accessToken }
      );
      user = await UserModel.findById(user._id);
    } else {
      // Check if a user with this username already exists (e.g. created
      // manually without externalIDs.github). Link the GitHub ID to the
      // existing account instead of creating a duplicate that would lose
      // the isAdmin flag.
      user = await UserModel.findOne({ username: profile.username });
      if (user) {
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
              "accessTokens.github": accessToken,
              "accessTokenDates.github": now,
            },
          }
        );
        user = await UserModel.findById(user._id);
      } else {
        const photo = profile.photos ? profile.photos[0]?.value : null;
        user = new UserModel({
          username: profile.username,
          accessTokens: {
            github: accessToken,
          },
          accessTokenDates: {
            github: now,
          },
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
    done(null, {
      username: profile.username,
      accessToken,
      refreshToken,
      profile,
      user,
    });
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

passport.use(
  new Strategy(
    {
      clientID: config.CLIENT_ID,
      clientSecret: config.CLIENT_SECRET,
      callbackURL: config.AUTH_CALLBACK,
    },
    verify
  )
);

passport.serializeUser((user: Express.User, done) => {
  done(null, user);
});

passport.deserializeUser((user: Express.User, done) => {
  done(null, user);
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

router.get(
  "/login",
  passport.authenticate("github", { scope: ["repo"] }), // Note the scope here
  function (req: express.Request, res: express.Response) {
    res.redirect("/");
  }
);

router.get(
  "/auth",
  passport.authenticate("github", { failureRedirect: "/" }),
  function (req: express.Request, res: express.Response) {
    res.redirect("/");
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
        accessToken: model.accessTokens?.github,
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
