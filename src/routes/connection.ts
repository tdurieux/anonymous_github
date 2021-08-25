import * as redis from "redis";
import * as passport from "passport";
import * as session from "express-session";
import * as connectRedis from "connect-redis";
import * as OAuth2Strategy from "passport-oauth2";
import { Profile, Strategy } from "passport-github2";
import * as express from "express";

import config from "../../config";
import UserModel from "../database/users/users.model";

const RedisStore = connectRedis(session);

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
  let user;
  try {
    user = await UserModel.findOne({ username: profile.username });
    const email = profile.emails ? profile.emails[0]?.value : null;
    const photo = profile.photos ? profile.photos[0]?.value : null;
    if (user) {
      user.accessToken = accessToken;
      user.email = photo;
      user.photo = photo;
      await user.save();
    } else {
      user = await new UserModel({
        username: profile.username,
        accessToken: accessToken,
        email,
        photo,
      }).save();
    }
  } catch (error) {
    console.error(error);
  } finally {
    done(null, {
      username: profile.username,
      accessToken,
      refreshToken,
      profile,
      user,
    });
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

export const appSession = session({
  secret: "keyboard cat",
  store: new RedisStore({
    client: redis.createClient({
      port: config.REDIS_PORT,
      host: config.REDIS_HOSTNAME,
    }),
  }),
  saveUninitialized: false,
  resave: false,
});

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
