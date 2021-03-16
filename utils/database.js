const config = require("../config");

var MongoClient = require("mongodb").MongoClient;
const MONGO_URL = "mongodb://root:rootpassword@mongodb:27017/?authSource=admin";
let mongoClient = null;
let DB = null;

module.exports.get = (collection) => {
  if (!collection) return DB;
  return DB.collection(collection);
};

module.exports.connect = async () => {
  mongoClient = await MongoClient.connect(
    MONGO_URL,
    { useNewUrlParser: true, useUnifiedTopology: true }
  );
  DB = mongoClient.db("anonymous_github");
  await DB.collection("anonymized_repositories").createIndex(
    { repoId: 1 },
    { unique: true, name: "repoId" }
  );
  await DB.collection("anonymized_repositories").createIndex(
    { fullName: 1 },
    { name: "fullName" }
  );
  await DB.collection("repositories").createIndex(
    { fullName: 1 },
    { unique: true, name: "fullName" }
  );
  await DB.collection("users").createIndex(
    { username: 1 },
    { unique: true, name: "username" }
  );
  return DB;
};
module.exports.close = async () => {
  return await mongoClient.close();
};
