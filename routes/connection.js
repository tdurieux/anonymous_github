const redis = require("redis");

const passport = require("passport");
const session = require("express-session");
const redisStore = require("connect-redis")(session);
const GitHubStrategy = require("passport-github2").Strategy;

const express = require("express");

const router = express.Router();

const db = require("../utils/database");
const config = require("../config");

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: "not_connected" });
}

passport.serializeUser(function(user, done) {
  delete user.profile._json;
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  done(null, obj);
});

passport.use(
  new GitHubStrategy(
    {
      clientID: config.CLIENT_ID,
      clientSecret: config.CLIENT_SECRET,
      callbackURL: config.AUTH_CALLBACK,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        await db
          .get()
          .collection("users")
          .updateOne(
            { username: profile.username },
            {
              $set: {
                username: profile.username,
                profile,
                accessToken,
                refreshToken,
              },
            },
            { upsert: true }
          );
      } catch (error) {
        console.error(error);
      } finally {
        done(null, {
          username: profile.username,
          accessToken,
          refreshToken,
          profile,
        });
      }
    }
  )
);

const rediscli = redis.createClient({
  host: "redis",
  ttl: 260,
});

const appSession = session({
  secret: "keyboard cat",
  store: new redisStore({
    client: rediscli,
  }),
  saveUninitialized: false,
  resave: false,
});

router.get(
  "/login",
  passport.authenticate("github", { scope: ["repo"] }), // Note the scope here
  function(req, res) {
    res.redirect("/");
  }
);

router.get(
  "/auth",
  passport.authenticate("github", { failureRedirect: "/" }),
  function(req, res) {
    res.redirect("/");
  }
);

module.exports.ensureAuthenticated = ensureAuthenticated;
module.exports.passport = passport;
module.exports.session = appSession;
module.exports.router = router;
