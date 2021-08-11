import * as mongoose from "mongoose";
import config from "./config";
import * as database from "./src/database/database";
import RepositoryModel from "./src/database/repositories/repositories.model";
import AnonymizedRepositoryModel from "./src/database/anonymizedRepositories/anonymizedRepositories.model";
import UserModel from "./src/database/users/users.model";
import { IRepositoryDocument } from "./src/database/repositories/repositories.types";
import { LexRuntime } from "aws-sdk";

const MONGO_URL = `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/`;

async function connect(db) {
  const t = new mongoose.Mongoose();
  t.set("useNewUrlParser", true);
  t.set("useFindAndModify", true);
  t.set("useUnifiedTopology", true);

  const database = t.connection;

  await t.connect(MONGO_URL + db, {
    authSource: "admin",
    useCreateIndex: true,
    useFindAndModify: true,
  });

  return database;
}

(async () => {
  await database.connect();
  const oldDB = await connect("anonymous_github");

  console.log("Import Users");
  await new Promise(async (resolve) => {
    const promises = [];
    await oldDB
      .collection("users")
      .find()
      .batchSize(1)
      .forEach(async (r) => {
        let localResolve = null;
        const p = new Promise((r) => (localResolve = r));
        promises.push(p);

        const repositoryModels: Promise<IRepositoryDocument>[] = [];
        const finds = (
          await RepositoryModel.find({
            externalId: {
              $in: r.repositories.map((repo) => "gh_" + repo.id),
            },
          }).select("externalId")
        ).map((m) => m.externalId);
        for (const repo of r.repositories.filter(
          (f) => finds.indexOf("gh_" + f.id) == -1
        )) {
          repositoryModels.push(
            new RepositoryModel({
              externalId: "gh_" + repo.id,
              name: repo.full_name,
              url: repo.html_url,
              size: repo.size,
              defaultBranch: repo.default_branch,
            }).save()
          );
        }
        const user = await new UserModel({
          accessToken: r.accessToken,
          username: r.username,
          email: r.profile.emails[0]?.value,
          photo: r.profile.photos[0]?.value,
          repositories: (await Promise.all(repositoryModels)).map((d) => d._id),
          default: {
            terms: r.default.terms,
            options: r.default.options,
          },
        }).save();

        localResolve(user);
      });
    Promise.all(promises).then(resolve);
  });

  console.log("Import Repositories");
  let promises = [];
  await oldDB
    .collection("repositories")
    .find({})
    .batchSize(1)
    .forEach(async (r) => {
      if (!r.id) return;
      let localResolve = null;
      const p = new Promise((r) => (localResolve = r));
      promises.push(p);

      let find = await RepositoryModel.findOne({
        externalId: "gh_" + r.id,
      });
      // console.log("gh_" + r.id, find != null);
      if (find == null) {
        find = new RepositoryModel({
          externalId: "gh_" + r.id,
          name: r.fullName,
          url: r.html_url,
          size: r.size,
          defaultBranch: r.default_branch,
        });
      }
      const branches = [...Object.values(r.branches)].map((b: any) => {
        const o: any = { name: b.name, commit: b.commit.sha };
        if (b.name == find.defaultBranch) {
          o.readme = r.readme;
        }
        return o;
      });
      find.branches = branches;
      await find.save();
      localResolve();
    });
  await Promise.all(promises);
  console.log("Import Anonymized Repositories");
  promises = [];
  await oldDB
    .collection("anonymized_repositories")
    .find({})
    .forEach(async (r) => {
      let localResolve = null;
      const p = new Promise((r) => (localResolve = r));
      promises.push(p);

      let repo = await RepositoryModel.findOne({ name: r.fullName });
      if (repo == null) {
        const tmp = await oldDB
          .collection("repositories")
          .findOne({ fullName: r.fullName });
        if (tmp) {
          repo = await RepositoryModel.findOne({ externalId: "gh_" + tmp.id });
        } else {
          console.error(`Repository ${r.fullName} is not found (renamed)`);
        }
      }
      await new AnonymizedRepositoryModel({
        repoId: r.repoId,
        status: r.status,
        anonymizeDate: r.anonymizeDate,
        lastView: r.lastView,
        pageView: r.pageView,
        owner: r.owner,
        source: {
          accessToken: r.token,
          type:
            r.options.mode == "download" ? "GitHubDownload" : "GitHubStream",
          branch: r.branch,
          commit: r.commit,
          repositoryId: repo?.id,
          repositoryName: r.fullName,
        },
        options: {
          terms: r.terms,
          expirationMode: r.options.expirationMode,
          expirationDate: r.options.expirationDate
            ? new Date(r.options.expirationDate)
            : null,
          update: r.options.update,
          image: r.options.image,
          pdf: r.options.pdf,
          notebook: r.options.notebook,
          loc: r.options.loc,
          link: r.options.link,
          page: r.options.page,
          pageSource: r.options.pageSource,
        },
      }).save();
      localResolve();
    });
  await Promise.all(promises);
  console.log("Import finished!");
  setTimeout(() => process.exit(), 5000);
})();
