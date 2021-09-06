require("dotenv").config();

import * as mongoose from "mongoose";
import config from "./config";
import * as database from "./src/database/database";
import RepositoryModel from "./src/database/repositories/repositories.model";
import AnonymizedRepositoryModel from "./src/database/anonymizedRepositories/anonymizedRepositories.model";
import UserModel from "./src/database/users/users.model";

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
  let index = 0;
  const userQuery = oldDB.collection("users").find();
  const totalUser = await userQuery.count();

  while (await userQuery.hasNext()) {
    const r = await userQuery.next();
    index++;
    console.log(`Import User [${index}/${totalUser}]: ${r.username}`);

    const newRepos = [];
    const allRepoIds = [];
    if (r.repositories) {
      const finds = await RepositoryModel.find({
        externalId: {
          $in: r.repositories.map((repo) => "gh_" + repo.id),
        },
      }).select("externalId");
      finds.forEach((f) => allRepoIds.push(f.id));

      const repoIds = new Set<string>();
      const toInsert = r.repositories.filter((f) => {
        if (repoIds.has(f.id)) return false;
        repoIds.add(f.id);
        const externalId = "gh_" + f.id;
        return finds.filter((f) => f.externalId == externalId).length == 0;
      });

      for (const repo of toInsert) {
        newRepos.push(
          new RepositoryModel({
            externalId: "gh_" + repo.id,
            name: repo.full_name,
            url: repo.html_url,
            size: repo.size,
            defaultBranch: repo.default_branch,
          })
        );
      }
      if (newRepos.length > 0) {
        await RepositoryModel.insertMany(newRepos);
      }
      newRepos.forEach((f) => allRepoIds.push(f.id));
    }
    const user = new UserModel({
      accessTokens: {
        github: r.accessToken,
      },
      externalIDs: {
        github: r.profile.id,
      },
      username: r.username,
      emails: r.profile.emails?.map((email) => {
        return { email: email.value, default: false };
      }),
      photo: r.profile.photos[0]?.value,
      repositories: allRepoIds,
      default: {
        terms: r.default?.terms,
        options: r.default?.options,
      },
    });
    if (user.emails?.length) user.emails[0].default = true;

    await user.save();
  }

  console.log("Import Repositories");
  const repoQuery = oldDB.collection("repositories").find();
  const totalRepository = await repoQuery.count();
  index = 0;
  while (await repoQuery.hasNext()) {
    const r = await repoQuery.next();
    if (!r.id) continue;
    index++;
    console.log(
      `Import Repository [${index}/${totalRepository}]: ${r.fullName}`
    );

    let find = await RepositoryModel.findOne({
      externalId: "gh_" + r.id,
    });

    if (find == null) {
      find = new RepositoryModel({
        externalId: "gh_" + r.id,
        name: r.fullName,
        url: r.html_url,
        size: r.size,
        defaultBranch: r.default_branch,
      });
    }
    if (r.branches) {
      const branches = [...Object.values(r.branches)].map((b: any) => {
        const o: any = { name: b.name, commit: b.commit.sha };
        if (b.name == find.defaultBranch) {
          o.readme = r.readme;
        }
        return o;
      });
      find.branches = branches;
    }
    await find.save();
  }

  console.log("Import Anonymized Repositories");
  const anoQuery = oldDB.collection("anonymized_repositories").find();
  const totalAno = await anoQuery.count();
  index = 0;
  while (await anoQuery.hasNext()) {
    const r = await anoQuery.next();

    index++;
    console.log(
      `Import Anonymized Repository [${index}/${totalAno}]: ${r.repoId}`
    );

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
    let size = { storage: 0, file: 0 };
    function recursiveCount(files) {
      const out = { storage: 0, file: 0 };
      for (const name in files) {
        const file = files[name];
        if (file.size && file.sha && parseInt(file.size) == file.size) {
          out.storage += file.size as number;
          out.file++;
        } else if (typeof file == "object") {
          const r = recursiveCount(file);
          out.storage += r.storage;
          out.file += r.file;
        }
      }
      return out;
    }

    if (r.originalFiles) {
      size = recursiveCount(r.originalFiles);
    }
    const owner = await UserModel.findOne({ username: r.owner }).select("_id");
    await new AnonymizedRepositoryModel({
      repoId: r.repoId,
      status: r.status,
      anonymizeDate: r.anonymizeDate,
      lastView: r.lastView,
      pageView: r.pageView,
      owner: owner?.id,
      size,
      source: {
        accessToken: r.token,
        type: r.options.mode == "download" ? "GitHubDownload" : "GitHubStream",
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
  }
  console.log("Import finished!");
  setTimeout(() => process.exit(), 5000);
})();
